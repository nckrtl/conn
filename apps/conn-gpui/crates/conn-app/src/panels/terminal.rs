//! Terminal surface powered by `alacritty_terminal` 0.26 and a custom GPUI Element.
//!
//! The terminal belongs to the thread on screen. A thread on this Mac's own server gets the
//! user's login shell in a local PTY, started lazily on first display in the thread's folder
//! (fallback `$HOME`). A thread on a linked environment gets a shell on that machine instead:
//! the panel attaches to the thread's `terminal.*` RPCs on that environment's connection and
//! feeds the output into the same emulator. Sessions are kept per environment and thread.
//! Repaints happen only on output (no continuous animation/blink loop), and a local PTY child is
//! killed when its session is dropped.

use crate::a11y::ConnA11yExt as _;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use alacritty_terminal::event::{Event as TermEvent, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line as GridLine, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{
    CursorShape, CursorStyle as AnsiCursorStyle, Processor as AnsiProcessor,
};
use conn_client::Connection;
use conn_contract::TerminalAttachStreamEvent;
use conn_state::terminal_settings::{CursorStyle as TerminalCursorStyle, TerminalSettings};
use conn_theme::Tokens;
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, BorderStyle, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, DispatchPhase,
    Element, ElementId, ElementInputHandler, Entity, EntityInputHandler, FocusHandle, Focusable,
    Font, FontWeight, GlobalElementId, Hitbox, HitboxBehavior, Hsla, InspectorElementId,
    InteractiveElement, IntoElement, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render, ScrollDelta, ScrollEvent,
    ShapedLine, StrikethroughStyle, Style, Styled, Task, TextAlign, TextRun, UTF16Selection,
    UnderlineStyle, Window, div, fill, font, outline, point, px, relative, size,
};
use tokio::sync::mpsc;

use super::color::{Rgb8, rgb8_to_hsla, to_hsla};
use super::header::superhero_icon;
use super::terminal_palette::{
    KeyInput, TerminalKeyAction, TerminalPalette, dim_rgb8, encode_terminal_key,
};
use super::terminal_target::{
    DEFAULT_TERMINAL_ID, SessionKey, TerminalTarget, attach_input, write_chunks,
};

const TERMINAL_PAD_START_PX: f32 = 16.0;
/// Smallest top padding above the first terminal row (very tall cells).
const TERMINAL_PAD_TOP_MIN_PX: f32 = 4.0;
/// Offset of the floating toolbar from the panel's top edge.
const TOOLBAR_TOP_PX: f32 = 8.0;
const TERMINAL_PAD_END_PX: f32 = 12.0;
const TERMINAL_PAD_BOTTOM_PX: f32 = 12.0;
const TOOLBAR_HEIGHT_PX: f32 = 32.0;
const TOOLBAR_INNER_PAD_PX: f32 = 3.0;
const TOOLBAR_BTN_SIZE_PX: f32 = 24.0;

/// Top padding that centres the first terminal row on the floating toolbar's centre line.
fn terminal_pad_top(cell_height: f32) -> f32 {
    (TOOLBAR_TOP_PX + TOOLBAR_HEIGHT_PX / 2.0 - cell_height / 2.0).max(TERMINAL_PAD_TOP_MIN_PX)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct GridSize {
    cols: u16,
    rows: u16,
    cell_width: f32,
    cell_height: f32,
}

impl Default for GridSize {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            cell_width: 8.0,
            cell_height: 18.0,
        }
    }
}

impl GridSize {
    fn window_size(self) -> WindowSize {
        WindowSize {
            num_lines: self.rows,
            num_cols: self.cols,
            cell_width: self.cell_width.round().max(1.0) as u16,
            cell_height: self.cell_height.round().max(1.0) as u16,
        }
    }
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

enum TermNote {
    Wakeup,
    Exited,
    Copy(String),
    /// A remote terminal broke: the server refused it, or the connection to it ended.
    Failed(String),
}

struct SharedState {
    dirty: AtomicBool,
    sender: OnceLock<EventLoopSender>,
    notes: mpsc::UnboundedSender<TermNote>,
}

#[derive(Clone)]
struct Listener(Arc<SharedState>);

impl EventListener for Listener {
    fn send_event(&self, event: TermEvent) {
        match event {
            TermEvent::Wakeup => {
                // Coalesce bursts of PTY output into a single UI repaint notification.
                if !self.0.dirty.swap(true, Ordering::AcqRel) {
                    let _ = self.0.notes.send(TermNote::Wakeup);
                }
            }
            TermEvent::Exit | TermEvent::ChildExit(_) => {
                let _ = self.0.notes.send(TermNote::Exited);
            }
            TermEvent::ClipboardStore(_, text) => {
                let _ = self.0.notes.send(TermNote::Copy(text));
            }
            _ => {}
        }
    }
}

/// Live terminal session owned by [`TerminalPanel`]: a local PTY, or a shell on a linked
/// environment ([`RemoteLink`]). Kills a local child process on drop; a remote shell keeps
/// running on its server and the next attach picks it up again.
struct TerminalSession {
    term: Arc<FairMutex<Term<Listener>>>,
    shared: Arc<SharedState>,
    #[cfg(unix)]
    child_pid: Option<i32>,
    size: GridSize,
    exited: bool,
    failed: Option<String>,
    /// Set when the shell runs on the thread's server.
    remote: Option<RemoteLink>,
    _events_task: Task<()>,
}

/// A request for the server that owns a remote terminal, sent in order.
enum RemoteOp {
    Write(String),
    Resize { cols: u16, rows: u16 },
    Clear,
}

/// The connection to a terminal on the thread's own server (`terminal.attach` stream plus
/// `terminal.write`, `.resize` and `.clear` calls). Dropping it ends the stream.
struct RemoteLink {
    connection: Connection,
    ops: mpsc::UnboundedSender<RemoteOp>,
    _reader: Task<()>,
    _writer: Task<()>,
}

impl TerminalSession {
    /// A session with an empty screen and no shell yet.
    fn empty(
        config: Config,
        size: GridSize,
        key: SessionKey,
        cx: &mut Context<'_, TerminalPanel>,
    ) -> Self {
        let (notes_tx, mut notes_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(SharedState {
            dirty: AtomicBool::new(false),
            sender: OnceLock::new(),
            notes: notes_tx,
        });
        let term = Arc::new(FairMutex::new(Term::new(
            config,
            &size,
            Listener(shared.clone()),
        )));
        let events_task = cx.spawn(async move |this, cx| {
            while let Some(note) = notes_rx.recv().await {
                let alive = this.update(cx, |panel, cx| panel.handle_note(&key, note, cx));
                if alive.is_err() {
                    break;
                }
            }
        });
        Self {
            term,
            shared,
            #[cfg(unix)]
            child_pid: None,
            size,
            exited: false,
            failed: None,
            remote: None,
            _events_task: events_task,
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if let Some(sender) = self.shared.sender.get() {
            let _ = sender.send(Msg::Shutdown);
        }
        #[cfg(unix)]
        if let Some(pid) = self.child_pid.take()
            && pid > 0
            && !self.exited
        {
            // SAFETY: `pid` is the child shell's own process ID returned by `tty::new` (which
            // starts the shell in a new session via setsid, making `-pid` its process group).
            // Sending SIGHUP asks the login shell and its foreground jobs to exit cleanly.
            unsafe {
                libc::kill(-pid, libc::SIGHUP);
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}

/// Last painted terminal viewport origin and cell geometry, for pointer-to-cell hit testing.
#[derive(Clone, Copy, Debug, PartialEq)]
struct DrawnAt {
    origin: Point<Pixels>,
    cell_width: Pixels,
    cell_height: Pixels,
}

/// Interactive terminal panel backed by `alacritty_terminal`. It shows the session of the thread
/// on screen ([`TerminalTarget`]); sessions of other threads stay alive beside it.
pub(crate) struct TerminalPanel {
    tokens: Tokens,
    palette: TerminalPalette,
    /// The thread on screen: its session key, folder, machine name and where its shell runs.
    target: TerminalTarget,
    /// The connection of the thread's environment, for a remote shell.
    connection: Option<Connection>,
    sessions: HashMap<SessionKey, TerminalSession>,
    focus: FocusHandle,
    marked: String,
    scroll_remainder: f32,
    drawn_at: Option<DrawnAt>,
    selecting: bool,
    /// The cursor style last given to the running terminal, to re-apply it when Settings changes.
    applied_cursor: Option<(TerminalCursorStyle, bool)>,
    /// The blinking cursor is in its visible half, and the timer that flips it.
    blink_on: bool,
    blink_task: Option<Task<()>>,
}

/// Half a blink period: the cursor is visible for this long, then hidden for this long. The
/// Settings example blinks on the same period (`terminal_demo`).
pub(crate) const CURSOR_BLINK_MS: u64 = 530;

impl fmt::Debug for TerminalPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalPanel")
            .field("target", &self.target)
            .field("sessions", &self.sessions.len())
            .finish_non_exhaustive()
    }
}

impl TerminalPanel {
    pub(crate) fn new(tokens: Tokens, cx: &mut Context<'_, Self>) -> Self {
        let palette = TerminalPalette::from_tokens(&tokens);
        Self {
            tokens,
            palette,
            target: TerminalTarget::default(),
            connection: None,
            sessions: HashMap::new(),
            focus: cx.focus_handle(),
            marked: String::new(),
            scroll_remainder: 0.0,
            drawn_at: None,
            selecting: false,
            applied_cursor: None,
            blink_on: true,
            blink_task: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.palette = TerminalPalette::from_tokens(&tokens);
        self.tokens = tokens;
        cx.notify();
    }

    /// The session of the thread on screen.
    fn session(&self) -> Option<&TerminalSession> {
        self.sessions.get(&self.target.key)
    }

    fn session_mut(&mut self) -> Option<&mut TerminalSession> {
        self.sessions.get_mut(&self.target.key)
    }

    /// Points the terminal at the thread on screen: its machine, folder and connection. The
    /// thread's own session shows (a new one starts on the next [`Self::ensure_started`]); the
    /// sessions of other threads are kept but never shown here.
    pub(crate) fn set_target(
        &mut self,
        target: TerminalTarget,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        // A session that ran over a connection the thread no longer has (the link was renewed)
        // starts again over the new one; its shell kept running on the server.
        let stale: Vec<SessionKey> = self
            .sessions
            .iter()
            .filter(|(key, session)| {
                session.remote.as_ref().is_some_and(|link| {
                    **key == target.key
                        && connection
                            .as_ref()
                            .is_some_and(|new| !new.same_connection(&link.connection))
                })
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            self.sessions.remove(&key);
        }
        if self.target == target && same_connection(self.connection.as_ref(), connection.as_ref()) {
            return;
        }
        self.target = target;
        self.connection = connection;
        cx.notify();
    }

    /// Test helper: what the panel shows now.
    #[cfg(test)]
    pub(crate) fn target_for_test(&self) -> &TerminalTarget {
        &self.target
    }

    /// Test helper: every session, with where its shell runs (`local` or `remote`), by key.
    #[cfg(test)]
    pub(crate) fn sessions_for_test(&self) -> Vec<(SessionKey, &'static str)> {
        let mut sessions: Vec<_> = self
            .sessions
            .iter()
            .map(|(key, session)| {
                let backend = if session.remote.is_some() {
                    "remote"
                } else {
                    "local"
                };
                (key.clone(), backend)
            })
            .collect();
        sessions.sort_by(|a, b| format!("{:?}", a.0).cmp(&format!("{:?}", b.0)));
        sessions
    }

    /// Test helper: the thread on screen waits for its server's connection.
    #[cfg(test)]
    pub(crate) fn waiting_for_connection_for_test(&self) -> bool {
        self.waiting_for_connection()
    }

    /// The machine the shown terminal runs on, for the header (`Terminal · agent`).
    pub(crate) fn machine_label(&self) -> Option<&str> {
        self.target.label.as_deref()
    }

    /// Gives running terminals the cursor shape from Settings, once per change.
    fn apply_cursor_settings(&mut self, settings: &TerminalSettings) {
        let wanted = (settings.cursor_style, settings.cursor_blink);
        if self.applied_cursor == Some(wanted) {
            return;
        }
        self.applied_cursor = Some(wanted);
        for session in self.sessions.values() {
            session.term.lock().set_options(terminal_config(settings));
        }
    }

    /// Runs the blink timer while a blinking cursor is on a focused terminal, and only then:
    /// an idle or unfocused terminal repaints on output alone.
    fn sync_blink(&mut self, active: bool, cx: &mut Context<'_, Self>) {
        if !active {
            if self.blink_task.take().is_some() {
                self.blink_on = true;
            }
            return;
        }
        if self.blink_task.is_some() {
            return;
        }
        self.blink_on = true;
        self.blink_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(CURSOR_BLINK_MS))
                    .await;
                let alive = this.update(cx, |panel, cx| {
                    panel.blink_on = !panel.blink_on;
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        }));
    }

    /// Whether the thread on screen waits for its server's connection before its shell can start.
    fn waiting_for_connection(&self) -> bool {
        self.target.remote && self.connection.is_none() && self.session().is_none()
    }

    /// Lazily starts the thread's shell on first display of the Terminal tab: a local PTY, or a
    /// shell on the thread's server. A remote thread whose server is not connected yet waits; it
    /// never falls back to this Mac.
    pub(crate) fn ensure_started(&mut self, cx: &mut Context<'_, Self>) {
        if self.session().is_some() {
            return;
        }
        self.start_current(false, cx);
    }

    /// Starts the shell for the thread on screen. `fresh` makes a remote shell start over.
    fn start_current(&mut self, fresh: bool, cx: &mut Context<'_, Self>) {
        let key = self.target.key.clone();
        let session = if self.target.remote {
            let Some(connection) = self.connection.clone() else {
                return;
            };
            self.start_remote_session(&key, connection, fresh, cx)
        } else {
            let cwd = resolve_cwd(self.target.cwd.as_deref());
            self.start_session(&key, cwd, cx)
        };
        self.sessions.insert(key, session);
        cx.notify();
    }

    /// Moves keyboard focus to the terminal.
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut Context<'_, Self>) {
        window.focus(&self.focus, cx);
    }

    /// Restarts the shell of the thread on screen in its folder.
    fn restart_session(&mut self, cx: &mut Context<'_, Self>) {
        self.sessions.remove(&self.target.key.clone());
        self.start_current(true, cx);
    }

    /// Clears the terminal screen and scrollback (equivalent to Ctrl+L / clear).
    fn clear_terminal(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(session) = self.session() {
            let mut term = session.term.lock();
            term.grid_mut().clear_history();
            term.scroll_display(Scroll::Bottom);
            drop(term);
            if let Some(link) = &session.remote {
                let _ = link.ops.send(RemoteOp::Clear);
            }
            self.write_bytes(b"\x0c".to_vec());
            cx.notify();
        }
    }

    fn start_session(
        &self,
        key: &SessionKey,
        cwd: PathBuf,
        cx: &mut Context<'_, Self>,
    ) -> TerminalSession {
        let config = terminal_config(&crate::terminal_settings::current(cx));
        let mut session = TerminalSession::empty(config, GridSize::default(), key.clone(), cx);

        if let Err(err) = spawn_pty(&mut session, cwd) {
            session.exited = true;
            session.failed = Some(err.to_string());
        }

        session
    }

    /// Joins (or starts) the thread's terminal on its own server, in the thread's folder. The
    /// server keeps the shell and its scrollback; the first snapshot repaints the screen.
    fn start_remote_session(
        &self,
        key: &SessionKey,
        connection: Connection,
        fresh: bool,
        cx: &mut Context<'_, Self>,
    ) -> TerminalSession {
        let config = terminal_config(&crate::terminal_settings::current(cx));
        let mut session = TerminalSession::empty(config, GridSize::default(), key.clone(), cx);
        let Some(thread_id) = key.thread.clone() else {
            session.exited = true;
            session.failed = Some("open a thread to use its terminal".to_owned());
            return session;
        };
        let input = attach_input(
            &thread_id,
            self.target.cwd.as_deref(),
            session.size.cols,
            session.size.rows,
        );
        let (ops_tx, ops_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let reader = remote_reader(
            cx,
            connection.clone(),
            input,
            fresh,
            session.term.clone(),
            session.shared.clone(),
            ready_tx,
        );
        let writer = remote_writer(
            cx,
            connection.clone(),
            thread_id,
            session.shared.notes.clone(),
            ops_rx,
            ready_rx,
        );
        session.remote = Some(RemoteLink {
            connection,
            ops: ops_tx,
            _reader: reader,
            _writer: writer,
        });
        session
    }

    fn handle_note(&mut self, key: &SessionKey, note: TermNote, cx: &mut Context<'_, Self>) {
        let Some(session) = self.sessions.get_mut(key) else {
            return;
        };
        match note {
            TermNote::Wakeup => {
                session.shared.dirty.store(false, Ordering::Release);
            }
            TermNote::Exited => {
                session.exited = true;
            }
            TermNote::Failed(why) => {
                session.exited = true;
                session.failed = Some(why);
            }
            TermNote::Copy(text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
            }
        }
        if *key == self.target.key {
            cx.notify();
        }
    }

    fn write_bytes(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let Some(session) = self.session() else {
            return;
        };
        if session.exited {
            return;
        }
        if let Some(link) = &session.remote {
            for chunk in write_chunks(&bytes) {
                let _ = link.ops.send(RemoteOp::Write(chunk));
            }
        } else if let Some(sender) = session.shared.sender.get() {
            let _ = sender.send(Msg::Input(Cow::Owned(bytes)));
        }
    }

    fn resize(&mut self, next: GridSize) {
        let Some(session) = self.session_mut() else {
            return;
        };
        if session.size == next {
            return;
        }
        session.size = next;
        session.term.lock().resize(next);
        if !session.exited {
            if let Some(link) = &session.remote {
                let _ = link.ops.send(RemoteOp::Resize {
                    cols: next.cols,
                    rows: next.rows,
                });
            } else if let Some(sender) = session.shared.sender.get() {
                let _ = sender.send(Msg::Resize(next.window_size()));
            }
        }
    }

    fn key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<'_, Self>) {
        self.blink_on = true;
        let k = &event.keystroke;
        let m = k.modifiers;

        let command = if cfg!(target_os = "macos") {
            m.platform
        } else {
            m.control && m.shift
        };
        if command {
            match k.key.as_str() {
                "c" => {
                    if let Some(session) = self.session()
                        && let Some(text) = session.term.lock().selection_to_string()
                        && !text.is_empty()
                    {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                    cx.stop_propagation();
                }
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        self.send_text(&text, cx);
                    }
                    cx.stop_propagation();
                }
                "a" => {
                    self.select_all(cx);
                    cx.stop_propagation();
                }
                _ => {}
            }
            return;
        }

        let Some(session) = self.session() else {
            return;
        };
        if session.exited {
            return;
        }
        let mode = *session.term.lock().mode();
        let input = KeyInput {
            shift: m.shift,
            control: m.control,
            alt: m.alt,
            platform: m.platform,
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
        };
        match encode_terminal_key(&k.key, input) {
            TerminalKeyAction::Send(bytes) => {
                self.scroll_to_bottom();
                self.write_bytes(bytes);
                cx.stop_propagation();
            }
            TerminalKeyAction::ScrollPage(dir) => {
                let mut term = session.term.lock();
                term.scroll_display(if dir < 0 {
                    Scroll::PageUp
                } else {
                    Scroll::PageDown
                });
                drop(term);
                cx.notify();
                cx.stop_propagation();
            }
            TerminalKeyAction::Nothing => cx.stop_propagation(),
            TerminalKeyAction::Pass => {}
        }
    }

    fn send_text(&mut self, text: &str, cx: &mut Context<'_, Self>) {
        self.marked.clear();
        if text.is_empty() {
            cx.notify();
            return;
        }
        self.scroll_to_bottom();
        let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
        self.write_bytes(normalized.into_bytes());
        cx.notify();
    }

    fn scroll_to_bottom(&self) {
        if let Some(session) = self.session() {
            let mut term = session.term.lock();
            if term.grid().display_offset() != 0 {
                term.scroll_display(Scroll::Bottom);
            }
        }
    }

    fn select_all(&mut self, cx: &mut Context<'_, Self>) {
        let Some(session) = self.session() else {
            return;
        };
        let mut term = session.term.lock();
        let top = term.grid().topmost_line();
        let bottom = term.grid().bottommost_line();
        let last = term.grid().last_column();
        let mut selection = Selection::new(
            SelectionType::Simple,
            GridPoint::new(top, Column(0)),
            Side::Left,
        );
        selection.update(GridPoint::new(bottom, last), Side::Right);
        term.selection = Some(selection);
        drop(term);
        cx.notify();
    }

    fn cell_at(&self, position: Point<Pixels>, clamp: bool) -> Option<(usize, usize, Side)> {
        let at = self.drawn_at?;
        let size = self.session()?.size;
        map_point_to_cell(position, at, size, clamp)
    }

    fn grid_point(&self, col: usize, row: usize) -> Option<GridPoint> {
        let session = self.session()?;
        let offset = session.term.lock().grid().display_offset() as i32;
        Some(GridPoint::new(GridLine(row as i32 - offset), Column(col)))
    }

    fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        window.focus(&self.focus, cx);
        if event.button != MouseButton::Left {
            return;
        }
        let Some((col, row, side)) = self.cell_at(event.position, false) else {
            return;
        };
        let Some(grid_pt) = self.grid_point(col, row) else {
            return;
        };
        if let Some(session) = self.session() {
            let mut term = session.term.lock();
            match (
                event.click_count,
                event.modifiers.shift,
                term.selection.as_mut(),
            ) {
                (1, true, Some(selection)) => selection.update(grid_pt, side),
                (clicks, _, _) => {
                    let kind = match clicks {
                        2 => SelectionType::Semantic,
                        3.. => SelectionType::Lines,
                        _ => SelectionType::Simple,
                    };
                    term.selection = Some(Selection::new(kind, grid_pt, side));
                }
            }
        }
        self.selecting = true;
        cx.notify();
    }

    fn mouse_moved(&mut self, event: &MouseMoveEvent, cx: &mut Context<'_, Self>) {
        if !self.selecting {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            self.selecting = false;
            return;
        }
        let Some((col, row, side)) = self.cell_at(event.position, true) else {
            return;
        };
        let Some(grid_pt) = self.grid_point(col, row) else {
            return;
        };
        if let Some(session) = self.session()
            && let Some(selection) = session.term.lock().selection.as_mut()
        {
            selection.update(grid_pt, side);
        }
        cx.notify();
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<'_, Self>) {
        if event.button != MouseButton::Left || !self.selecting {
            return;
        }
        self.selecting = false;
        cx.notify();
    }

    fn scrolled(&mut self, event: &ScrollEvent, cx: &mut Context<'_, Self>) {
        let Some((term, cell_height)) = self
            .session()
            .map(|session| (session.term.clone(), session.size.cell_height))
        else {
            return;
        };
        let delta_lines = match event.delta {
            ScrollDelta::Lines(delta) => delta.y,
            ScrollDelta::Pixels(delta) => f32::from(delta.y) / cell_height.max(1.0),
        };
        self.scroll_remainder += delta_lines;
        let whole = self.scroll_remainder.trunc() as i32;
        if whole != 0 {
            self.scroll_remainder -= whole as f32;
            term.lock().scroll_display(Scroll::Delta(whole));
            cx.notify();
        }
        cx.stop_propagation();
    }
}

impl Focusable for TerminalPanel {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl EntityInputHandler for TerminalPanel {
    fn text_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        adjusted: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<String> {
        let utf16: Vec<u16> = self.marked.encode_utf16().collect();
        let clamped = range.start.min(utf16.len())..range.end.min(utf16.len());
        *adjusted = Some(clamped.clone());
        Some(String::from_utf16_lossy(&utf16[clamped]))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<std::ops::Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) {
        self.marked.clear();
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.send_text(text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<std::ops::Range<usize>>,
        new_text: &str,
        _new_selected: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.marked = new_text.to_owned();
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range: std::ops::Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(Bounds {
            origin: element_bounds.origin,
            size: size(px(8.0), px(18.0)),
        })
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> Option<usize> {
        None
    }

    fn accepts_text_input(&self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> bool {
        self.session().is_some_and(|s| !s.exited)
    }
}

impl Render for TerminalPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let control_bg = to_hsla(self.tokens.shell_control);
        let control_border = to_hsla(self.tokens.shell_divider_header);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let focused = self.focus.is_focused(window);
        let entity = cx.entity();

        let machine = self.target.label.clone();
        let remote = self.target.remote;
        let waiting = self.waiting_for_connection();
        let status_banner = if waiting {
            Some(match &machine {
                Some(name) => format!("Connecting to {name}…"),
                None => "Connecting to this thread's machine…".to_owned(),
            })
        } else {
            self.session().and_then(|s| {
                if !s.exited {
                    return None;
                }
                Some(match &s.failed {
                    Some(why) if remote => format!("Terminal unavailable: {why}"),
                    Some(why) => format!("Shell failed to start: {why}"),
                    None => "Shell process exited.".to_owned(),
                })
            })
        };

        // The first terminal row centres on the floating toolbar: its top padding is the toolbar's
        // centre line minus half a cell, so it follows the font size and line height.
        let cell_height =
            measure_font(window, cx, &crate::terminal_settings::current(cx)).cell_height;
        let pad_top = terminal_pad_top(cell_height);

        // Floating top-right ToolbarGroup matching `ThreadTerminalDrawer.tsx` (`absolute right-2 top-2`).
        let action_group = h_flex()
            .absolute()
            .top(px(TOOLBAR_TOP_PX))
            .right(px(8.0))
            .h(px(TOOLBAR_HEIGHT_PX))
            .px(px(TOOLBAR_INNER_PAD_PX))
            .gap(px(2.0))
            .items_center()
            .rounded(px(9999.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .when_some(machine, |el, name| {
                el.child(
                    div()
                        .id("terminal-machine-label")
                        .a11y_group("panel.terminal.machine", format!("Terminal on {name}"))
                        .px(px(8.0))
                        .text_size(px(12.0))
                        .text_color(muted)
                        .child(name),
                )
            })
            .child(
                div()
                    .id("terminal-clear-btn")
                    .a11y_button("panel.terminal.clear", "Clear terminal")
                    .size(px(TOOLBAR_BTN_SIZE_PX))
                    .rounded(px(9999.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.clear_terminal(cx);
                        }),
                    )
                    .child(superhero_icon("superhero/clean.svg", 14.0, muted)),
            )
            .child(
                div()
                    .id("terminal-restart-btn")
                    .a11y_button("panel.terminal.restart", "Restart terminal")
                    .size(px(TOOLBAR_BTN_SIZE_PX))
                    .rounded(px(9999.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            this.restart_session(cx);
                        }),
                    )
                    .child(superhero_icon("superhero/refresh.svg", 14.0, muted)),
            );

        v_flex()
            .id("terminal-panel")
            .a11y_group("panel.terminal", "Terminal")
            .relative()
            .size_full()
            .track_focus(&self.focus)
            .key_context("Terminal")
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                }),
            )
            .child(
                div()
                    .flex_1()
                    .size_full()
                    .pl(px(TERMINAL_PAD_START_PX))
                    .pt(px(pad_top))
                    .pr(px(TERMINAL_PAD_END_PX))
                    .pb(px(TERMINAL_PAD_BOTTOM_PX))
                    .child(TerminalElement {
                        panel: entity,
                        focused,
                    }),
            )
            .child(action_group)
            .when_some(status_banner, |el, msg| {
                el.child(
                    div()
                        .px(px(16.0))
                        .py(px(8.0))
                        .border_t_1()
                        .border_color(to_hsla(self.tokens.shell_divider))
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .text_color(muted)
                        .child(msg),
                )
            })
    }
}

fn resolve_cwd(workspace_root: Option<&str>) -> PathBuf {
    if let Some(root) = workspace_root
        && !root.is_empty()
    {
        let p = PathBuf::from(root);
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return PathBuf::from(home);
    }
    PathBuf::from("/")
}

fn spawn_pty(session: &mut TerminalSession, cwd: PathBuf) -> std::io::Result<()> {
    let shell_path = std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_owned()
            } else {
                "/bin/sh".to_owned()
            }
        });
    let mut env = std::collections::HashMap::new();
    env.insert("TERM".to_owned(), "xterm-256color".to_owned());
    env.insert("COLORTERM".to_owned(), "truecolor".to_owned());
    env.insert("TERM_PROGRAM".to_owned(), "Conn".to_owned());
    if std::env::var("LANG").map_or(true, |v| v.is_empty()) {
        env.insert("LANG".to_owned(), "en_US.UTF-8".to_owned());
    }

    let options = tty::Options {
        shell: Some(tty::Shell::new(shell_path, vec!["-l".to_owned()])),
        working_directory: Some(cwd),
        drain_on_exit: true,
        env,
        #[cfg(target_os = "windows")]
        escape_args: false,
    };

    let pty = tty::new(&options, session.size.window_size(), 0)?;
    #[cfg(unix)]
    {
        session.child_pid = Some(pty.child().id() as i32);
    }

    let event_loop = EventLoop::new(
        session.term.clone(),
        Listener(session.shared.clone()),
        pty,
        true,
        false,
    )?;
    let _ = session.shared.sender.set(event_loop.channel());
    let _reader = event_loop.spawn();
    Ok(())
}

// ---------------------------------------------------------------- terminal on the thread's server

/// What one `terminal.attach` event did to the screen.
#[derive(Debug, Default, PartialEq, Eq)]
struct RemoteOutcome {
    /// The server has the terminal: writes and resizes may go out now.
    ready: bool,
    /// The screen changed.
    redraw: bool,
    /// The shell ended or the server refused it.
    end: Option<RemoteEnd>,
}

#[derive(Debug, PartialEq, Eq)]
enum RemoteEnd {
    Exited,
    Failed(String),
}

/// Replaces the screen with what the server remembers of the terminal.
fn replace_screen(term: &FairMutex<Term<Listener>>, processor: &mut AnsiProcessor, history: &str) {
    let mut term = term.lock();
    // RIS resets the emulator, then the scrollback goes (`ESC [ 3 J`).
    processor.advance(&mut *term, b"\x1bc\x1b[3J");
    processor.advance(&mut *term, history.as_bytes());
}

/// Feeds one event of the terminal's stream into the emulator.
fn apply_remote_event(
    term: &FairMutex<Term<Listener>>,
    processor: &mut AnsiProcessor,
    event: TerminalAttachStreamEvent,
) -> RemoteOutcome {
    use conn_contract::TerminalSessionStatus as Status;
    match event {
        TerminalAttachStreamEvent::Snapshot(event) => {
            let snapshot = event.snapshot;
            replace_screen(term, processor, &snapshot.history);
            let end = match snapshot.status {
                Status::Exited => Some(RemoteEnd::Exited),
                Status::Error => {
                    Some(RemoteEnd::Failed(snapshot.error.unwrap_or_else(|| {
                        "the terminal failed to start".to_owned()
                    })))
                }
                Status::Starting | Status::Running => None,
            };
            RemoteOutcome {
                ready: true,
                redraw: true,
                end,
            }
        }
        TerminalAttachStreamEvent::Restarted(event) => {
            replace_screen(term, processor, &event.snapshot.history);
            RemoteOutcome {
                ready: true,
                redraw: true,
                end: None,
            }
        }
        TerminalAttachStreamEvent::Output(event) => {
            processor.advance(&mut *term.lock(), event.data.as_bytes());
            RemoteOutcome {
                redraw: true,
                ..RemoteOutcome::default()
            }
        }
        TerminalAttachStreamEvent::Cleared(_) => {
            let mut term = term.lock();
            term.grid_mut().clear_history();
            term.scroll_display(Scroll::Bottom);
            RemoteOutcome {
                redraw: true,
                ..RemoteOutcome::default()
            }
        }
        TerminalAttachStreamEvent::Exited(_) | TerminalAttachStreamEvent::Closed(_) => {
            RemoteOutcome {
                end: Some(RemoteEnd::Exited),
                ..RemoteOutcome::default()
            }
        }
        TerminalAttachStreamEvent::Error(event) => RemoteOutcome {
            end: Some(RemoteEnd::Failed(event.message)),
            ..RemoteOutcome::default()
        },
        _ => RemoteOutcome::default(),
    }
}

/// Reads the thread's terminal from its server into `term` until the session is dropped.
fn remote_reader(
    cx: &Context<'_, TerminalPanel>,
    connection: Connection,
    input: conn_contract::TerminalAttachInput,
    fresh: bool,
    term: Arc<FairMutex<Term<Listener>>>,
    shared: Arc<SharedState>,
    ready: tokio::sync::oneshot::Sender<()>,
) -> Task<()> {
    cx.background_executor().spawn(async move {
        if fresh {
            // A restart ends the old shell first, so the attach below starts a new one.
            let _ = connection
                .call_json(
                    "terminal.close",
                    serde_json::json!({
                        "threadId": input.thread_id,
                        "terminalId": input.terminal_id,
                        "deleteHistory": true,
                    }),
                )
                .await;
        }
        let Ok(payload) = serde_json::to_value(&input) else {
            return;
        };
        let (_stream, mut events) = connection.stream_json("terminal.attach", payload);
        let mut ready = Some(ready);
        let mut processor = AnsiProcessor::new();
        let wake = Listener(shared.clone());
        while let Some(raw) = events.recv().await {
            let Ok(event) = serde_json::from_value::<TerminalAttachStreamEvent>(raw) else {
                continue;
            };
            let outcome = apply_remote_event(&term, &mut processor, event);
            if outcome.ready
                && let Some(ready) = ready.take()
            {
                let _ = ready.send(());
            }
            if outcome.redraw {
                wake.send_event(TermEvent::Wakeup);
            }
            match outcome.end {
                Some(RemoteEnd::Exited) => {
                    let _ = shared.notes.send(TermNote::Exited);
                }
                Some(RemoteEnd::Failed(why)) => {
                    let _ = shared.notes.send(TermNote::Failed(why));
                }
                None => {}
            }
        }
        let _ = shared.notes.send(TermNote::Failed(
            "the connection to this terminal ended".to_owned(),
        ));
    })
}

/// Sends the session's input, resizes and clears to the server in order, once it has the
/// terminal.
fn remote_writer(
    cx: &Context<'_, TerminalPanel>,
    connection: Connection,
    thread_id: String,
    notes: mpsc::UnboundedSender<TermNote>,
    mut ops: mpsc::UnboundedReceiver<RemoteOp>,
    ready: tokio::sync::oneshot::Receiver<()>,
) -> Task<()> {
    cx.background_executor().spawn(async move {
        if ready.await.is_err() {
            return;
        }
        let session = serde_json::json!({
            "threadId": thread_id,
            "terminalId": DEFAULT_TERMINAL_ID,
        });
        while let Some(op) = ops.recv().await {
            let mut payload = session.clone();
            let (tag, input) = match op {
                RemoteOp::Write(data) => ("terminal.write", Some(data)),
                RemoteOp::Resize { cols, rows } => {
                    payload["cols"] = cols.into();
                    payload["rows"] = rows.into();
                    ("terminal.resize", None)
                }
                RemoteOp::Clear => ("terminal.clear", None),
            };
            if let Some(data) = input {
                payload["data"] = data.into();
            }
            if let Err(err) = connection.call_json(tag, payload).await
                && tag == "terminal.write"
            {
                let _ = notes.send(TermNote::Failed(err.to_string()));
            }
        }
    })
}

/// Whether two optional connections are the same one.
fn same_connection(a: Option<&Connection>, b: Option<&Connection>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.same_connection(b),
        (None, None) => true,
        _ => false,
    }
}

// ---------------------------------------------------------------- custom GPUI element

struct TerminalElement {
    panel: Entity<TerminalPanel>,
    focused: bool,
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

enum CursorPaint {
    Block,
    Outline(Bounds<Pixels>, Hsla),
    Bar(Bounds<Pixels>, Hsla),
}

struct PrepaintedTerminal {
    backgrounds: Vec<(Bounds<Pixels>, Hsla)>,
    lines: Vec<(Point<Pixels>, ShapedLine)>,
    cursor: Option<CursorPaint>,
    hitbox: Hitbox,
    cell_height: Pixels,
}

struct CellRun {
    column: usize,
    cells: usize,
    text: String,
    color: Rgb8,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    wide: bool,
}

impl CellRun {
    fn matches(
        &self,
        color: Rgb8,
        bold: bool,
        italic: bool,
        underline: bool,
        strike: bool,
    ) -> bool {
        !self.wide
            && self.color == color
            && self.bold == bold
            && self.italic == italic
            && self.underline == underline
            && self.strike == strike
    }
}

pub(super) struct FontMetrics {
    pub(super) font: Font,
    pub(super) size: Pixels,
    pub(super) cell_width: f32,
    pub(super) cell_height: f32,
}

/// The terminal's cursor as Alacritty's default: Settings' shape and blink.
fn terminal_config(settings: &TerminalSettings) -> Config {
    Config {
        default_cursor_style: AnsiCursorStyle {
            shape: match settings.cursor_style {
                TerminalCursorStyle::Block => CursorShape::Block,
                TerminalCursorStyle::Bar => CursorShape::Beam,
                TerminalCursorStyle::Underline => CursorShape::Underline,
            },
            blinking: settings.cursor_blink,
        },
        ..Config::default()
    }
}

/// Measures the terminal font from Settings → Terminal. A cell is one glyph advance plus the
/// letter spacing wide, and the font size times the line height tall, each on the pixel grid.
pub(super) fn measure_font(window: &Window, cx: &App, settings: &TerminalSettings) -> FontMetrics {
    let family: gpui_kit::SharedString = if settings.font_family.is_empty() {
        cx.theme().mono_font_family.clone()
    } else {
        settings.font_family.clone().into()
    };
    let mut f = font(family);
    f.weight = FontWeight(f32::from(settings.font_weight));
    let size = px(settings.font_size);
    let text = window.text_system();
    let id = text.resolve_font(&f);
    let advance = text
        .advance(id, size, 'W')
        .map(|s| f32::from(s.width))
        .unwrap_or(settings.font_size * 0.6);
    let scale = window.scale_factor();
    FontMetrics {
        font: f,
        size,
        cell_width: (((advance + settings.letter_spacing) * scale).round() / scale).max(1.0),
        cell_height: ((settings.cell_height() * scale).ceil() / scale).max(1.0),
    }
}

fn push_bg_run(
    row: usize,
    col: usize,
    cells: usize,
    color: Rgb8,
    out: &mut Vec<(usize, usize, usize, Rgb8)>,
) {
    if let Some(last) = out.last_mut()
        && last.0 == row
        && last.1 + last.2 == col
        && last.3 == color
    {
        last.2 += cells;
        return;
    }
    out.push((row, col, cells, color));
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintedTerminal;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.0).into();
        style.size.height = relative(1.0).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> PrepaintedTerminal {
        let settings = crate::terminal_settings::current(cx);
        let m = measure_font(window, cx, &settings);
        let (cw, ch) = (m.cell_width, m.cell_height);
        let cols = ((f32::from(bounds.size.width) / cw).floor() as u16).max(2);
        let rows = ((f32::from(bounds.size.height) / ch).floor() as u16).max(1);
        let grid = GridSize {
            cols,
            rows,
            cell_width: cw,
            cell_height: ch,
        };
        let blink_active = settings.cursor_blink && self.focused;
        self.panel.update(cx, |p, cx| {
            p.apply_cursor_settings(&settings);
            p.sync_blink(blink_active, cx);
            p.resize(grid);
            p.drawn_at = Some(DrawnAt {
                origin: bounds.origin,
                cell_width: px(cw),
                cell_height: px(ch),
            });
        });

        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let cell_rect = |col: usize, row: usize, cells: usize| Bounds {
            origin: point(
                bounds.origin.x + px(cw * col as f32),
                bounds.origin.y + px(ch * row as f32),
            ),
            size: size(px(cw * cells as f32), px(ch)),
        };

        let panel = self.panel.read(cx);
        let palette = panel.palette.clone();
        let Some(session) = panel.session() else {
            return PrepaintedTerminal {
                backgrounds: Vec::new(),
                lines: Vec::new(),
                cursor: None,
                hitbox,
                cell_height: px(ch),
            };
        };

        let default_bg = palette.background;
        let term = session.term.lock();
        let content = term.renderable_content();
        let offset = content.display_offset as i32;
        let selection = content.selection;
        let cursor = content.cursor;
        let cursor_row = cursor.point.line.0 + offset;
        let cursor_visible = cursor.shape != CursorShape::Hidden
            && (0..i32::from(rows)).contains(&cursor_row)
            && (!blink_active || panel.blink_on);
        let solid_cursor = cursor_visible && self.focused && cursor.shape == CursorShape::Block;
        let overrides = content.colors;

        let mut bg_cells: Vec<(usize, usize, usize, Rgb8)> = Vec::new();
        let mut runs: Vec<(usize, CellRun)> = Vec::new();

        for indexed in content.display_iter {
            let pt = indexed.point;
            let cell = indexed.cell;
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let row = (pt.line.0 + offset) as usize;
            let col = pt.column.0;
            let wide = cell.flags.contains(Flags::WIDE_CHAR);
            let cells = if wide { 2 } else { 1 };

            let mut fg = palette.resolve_fg(cell.fg, cell.flags.contains(Flags::BOLD), overrides);
            let mut bg = palette.resolve(cell.bg, overrides);
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if cell.flags.contains(Flags::DIM) {
                fg = dim_rgb8(fg, bg);
            }
            let selected = selection.is_some_and(|s| {
                s.contains(pt) || (wide && s.contains(GridPoint::new(pt.line, pt.column + 1)))
            });
            if selected {
                bg = palette.selection;
            }
            if cell.flags.contains(Flags::HIDDEN) {
                fg = bg;
            }
            if solid_cursor && pt == cursor.point {
                bg = palette.cursor;
                fg = default_bg;
            }
            if bg != default_bg {
                push_bg_run(row, col, cells, bg, &mut bg_cells);
            }

            let ch_char =
                if cell.c.is_control() || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                    ' '
                } else {
                    cell.c
                };
            let bold = cell.flags.contains(Flags::BOLD);
            let italic = cell.flags.contains(Flags::ITALIC);
            let underline = cell.flags.intersects(Flags::ALL_UNDERLINES);
            let strike = cell.flags.contains(Flags::STRIKEOUT);

            let can_extend = runs.last().is_some_and(|(r, run)| {
                *r == row
                    && run.column + run.cells == col
                    && run.matches(fg, bold, italic, underline, strike)
                    && !wide
            });
            if !can_extend {
                runs.push((
                    row,
                    CellRun {
                        column: col,
                        cells: 0,
                        text: String::new(),
                        color: fg,
                        bold,
                        italic,
                        underline,
                        strike,
                        wide,
                    },
                ));
            }
            if let Some((_, run)) = runs.last_mut() {
                run.text.push(ch_char);
                for extra in cell.zerowidth().into_iter().flatten() {
                    run.text.push(*extra);
                }
                run.cells += cells;
            }
        }

        let backgrounds: Vec<(Bounds<Pixels>, Hsla)> = bg_cells
            .into_iter()
            .map(|(row, col, cells, color)| (cell_rect(col, row, cells), rgb8_to_hsla(color)))
            .collect();

        let cursor_hsla = rgb8_to_hsla(palette.cursor);
        let cursor_paint = if !cursor_visible {
            None
        } else if solid_cursor {
            Some(CursorPaint::Block)
        } else {
            let rect = cell_rect(cursor.point.column.0, cursor_row as usize, 1);
            match cursor.shape {
                CursorShape::Beam => Some(CursorPaint::Bar(
                    Bounds {
                        origin: rect.origin,
                        size: size(px(2.0), rect.size.height),
                    },
                    cursor_hsla,
                )),
                CursorShape::Underline => Some(CursorPaint::Bar(
                    Bounds {
                        origin: point(rect.origin.x, rect.origin.y + rect.size.height - px(2.0)),
                        size: size(rect.size.width, px(2.0)),
                    },
                    cursor_hsla,
                )),
                _ => Some(CursorPaint::Outline(rect, cursor_hsla)),
            }
        };
        drop(term);

        let text_sys = window.text_system().clone();
        let mut lines = Vec::with_capacity(runs.len());
        for (row, run) in runs {
            if !run.underline && !run.strike && run.text.chars().all(|c| c == ' ') {
                continue;
            }
            let mut f = m.font.clone();
            if run.bold {
                f = f.bold();
            }
            if run.italic {
                f = f.italic();
            }
            let color = rgb8_to_hsla(run.color);
            let style = TextRun {
                len: run.text.len(),
                font: f,
                color,
                background_color: None,
                underline: run.underline.then_some(UnderlineStyle {
                    thickness: px(1.0),
                    color: Some(color),
                    wavy: false,
                }),
                strikethrough: run.strike.then_some(StrikethroughStyle {
                    thickness: px(1.0),
                    color: Some(color),
                }),
            };
            let force_width = (!run.wide).then_some(px(cw));
            let shaped = text_sys.shape_line(run.text.into(), m.size, &[style], force_width);
            lines.push((cell_rect(run.column, row, 1).origin, shaped));
        }

        PrepaintedTerminal {
            backgrounds,
            lines,
            cursor: cursor_paint,
            hitbox,
            cell_height: px(ch),
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepainted: &mut PrepaintedTerminal,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (rect, color) in &prepainted.backgrounds {
                window.paint_quad(fill(*rect, *color));
            }
            for (origin, line) in &prepainted.lines {
                let _ = line.paint(
                    *origin,
                    prepainted.cell_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
            match &prepainted.cursor {
                Some(CursorPaint::Outline(rect, color)) => {
                    window.paint_quad(outline(*rect, *color, BorderStyle::Solid));
                }
                Some(CursorPaint::Bar(rect, color)) => {
                    window.paint_quad(fill(*rect, *color));
                }
                Some(CursorPaint::Block) | None => {}
            }
        });

        let focus = self.panel.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.panel.clone()),
            cx,
        );
        window.set_cursor_style(CursorStyle::IBeam, &prepainted.hitbox);

        let (panel, hitbox) = (self.panel.clone(), prepainted.hitbox.clone());
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                panel.update(cx, |p, cx| p.mouse_down(event, window, cx));
                cx.stop_propagation();
            }
        });
        let panel = self.panel.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _window, cx| {
            if phase == DispatchPhase::Bubble {
                panel.update(cx, |p, cx| p.mouse_moved(event, cx));
            }
        });
        let panel = self.panel.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
            if phase == DispatchPhase::Bubble {
                panel.update(cx, |p, cx| p.mouse_up(event, cx));
            }
        });
        let (panel, hitbox) = (self.panel.clone(), prepainted.hitbox.clone());
        window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && hitbox.should_handle_scroll(window) {
                panel.update(cx, |p, cx| p.scrolled(event, cx));
            }
        });
    }
}

/// Maps a window point to a `(col, row, Side)` cell inside the terminal viewport.
fn map_point_to_cell(
    position: Point<Pixels>,
    drawn_at: DrawnAt,
    grid: GridSize,
    clamp: bool,
) -> Option<(usize, usize, Side)> {
    let x = f32::from(position.x - drawn_at.origin.x);
    let y = f32::from(position.y - drawn_at.origin.y);
    let (w, h) = (
        f32::from(drawn_at.cell_width),
        f32::from(drawn_at.cell_height),
    );
    let (cols, rows) = (f32::from(grid.cols), f32::from(grid.rows));
    if !clamp && (x < 0.0 || y < 0.0 || x >= w * cols || y >= h * rows) {
        return None;
    }
    let col = (x / w).floor().clamp(0.0, (cols - 1.0).max(0.0));
    let row = (y / h).floor().clamp(0.0, (rows - 1.0).max(0.0));
    let side = if x - col * w < w / 2.0 {
        Side::Left
    } else {
        Side::Right
    };
    Some((col as usize, row as usize, side))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_row_centres_on_the_toolbar_centre_line() {
        // Toolbar centre line sits at 8 + 32 / 2 = 24px from the panel's top edge.
        for cell_height in [14.0_f32, 18.0, 20.0, 23.0] {
            let pad = terminal_pad_top(cell_height);
            assert_eq!(pad + cell_height / 2.0, 24.0, "cell height {cell_height}");
        }
        assert_eq!(terminal_pad_top(18.0), 15.0);
    }

    #[test]
    fn first_row_padding_never_drops_below_the_minimum() {
        assert_eq!(terminal_pad_top(48.0), TERMINAL_PAD_TOP_MIN_PX);
        assert_eq!(terminal_pad_top(200.0), TERMINAL_PAD_TOP_MIN_PX);
    }

    #[test]
    fn map_point_to_cell_resolves_cell_side_and_clamps_drags() {
        let drawn = DrawnAt {
            origin: point(px(16.0), px(20.0)),
            cell_width: px(8.0),
            cell_height: px(18.0),
        };
        let grid = GridSize {
            cols: 10,
            rows: 4,
            cell_width: 8.0,
            cell_height: 18.0,
        };
        assert_eq!(
            map_point_to_cell(point(px(10.0), px(25.0)), drawn, grid, false),
            None
        );
        assert_eq!(
            map_point_to_cell(point(px(17.0), px(21.0)), drawn, grid, false),
            Some((0, 0, Side::Left))
        );
        assert_eq!(
            map_point_to_cell(point(px(22.0), px(21.0)), drawn, grid, false),
            Some((0, 0, Side::Right))
        );
        assert_eq!(
            map_point_to_cell(
                point(px(16.0 + 3.0 * 8.0 + 2.0), px(20.0 + 2.0 * 18.0 + 5.0)),
                drawn,
                grid,
                false
            ),
            Some((3, 2, Side::Left))
        );
        // Drag outside bounds clamps cleanly to the edges.
        assert_eq!(
            map_point_to_cell(point(px(500.0), px(500.0)), drawn, grid, true),
            Some((9, 3, Side::Right))
        );
        assert_eq!(
            map_point_to_cell(point(px(-50.0), px(-50.0)), drawn, grid, true),
            Some((0, 0, Side::Left))
        );
    }
}

#[cfg(test)]
mod remote_tests {
    use super::*;
    use conn_contract::from_json;
    use serde_json::json;

    fn test_term() -> (Arc<FairMutex<Term<Listener>>>, Arc<SharedState>) {
        let (notes, _rx) = mpsc::unbounded_channel();
        let shared = Arc::new(SharedState {
            dirty: AtomicBool::new(false),
            sender: OnceLock::new(),
            notes,
        });
        let term = Arc::new(FairMutex::new(Term::new(
            Config::default(),
            &GridSize::default(),
            Listener(shared.clone()),
        )));
        (term, shared)
    }

    fn event(value: serde_json::Value) -> TerminalAttachStreamEvent {
        from_json(value).expect("a terminal stream event")
    }

    fn first_row(term: &FairMutex<Term<Listener>>) -> String {
        let term = term.lock();
        (0..10)
            .map(|col| term.grid()[GridLine(0)][Column(col)].c)
            .collect::<String>()
            .trim_end()
            .to_owned()
    }

    fn snapshot(history: &str, status: &str) -> serde_json::Value {
        json!({
            "type": "snapshot",
            "snapshot": {
                "threadId": "t", "terminalId": "term-1", "cwd": "/srv", "worktreePath": null,
                "status": status, "pid": 1, "history": history, "exitCode": null,
                "exitSignal": null, "label": "zsh", "updatedAt": "2026-11-26T10:00:00.000Z"
            }
        })
    }

    #[test]
    fn a_snapshot_and_output_reach_the_screen() {
        let (term, _shared) = test_term();
        let mut processor = AnsiProcessor::new();
        let outcome =
            apply_remote_event(&term, &mut processor, event(snapshot("agent$ ", "running")));
        assert!(outcome.ready && outcome.redraw && outcome.end.is_none());
        assert_eq!(first_row(&term), "agent$");
        let output = event(json!({
            "type": "output", "threadId": "t", "terminalId": "term-1", "data": "ls"
        }));
        let outcome = apply_remote_event(&term, &mut processor, output);
        assert!(outcome.redraw && !outcome.ready);
        assert_eq!(first_row(&term), "agent$ ls");
        // A later snapshot (a re-attach) replaces the screen instead of adding to it.
        apply_remote_event(&term, &mut processor, event(snapshot("fresh", "running")));
        assert_eq!(first_row(&term), "fresh");
    }

    #[test]
    fn an_exited_or_failed_terminal_ends_the_session() {
        let (term, _shared) = test_term();
        let mut processor = AnsiProcessor::new();
        let outcome = apply_remote_event(&term, &mut processor, event(snapshot("", "exited")));
        assert_eq!(outcome.end, Some(RemoteEnd::Exited));
        let error = event(json!({
            "type": "error", "threadId": "t", "terminalId": "term-1", "message": "no such folder"
        }));
        let outcome = apply_remote_event(&term, &mut processor, error);
        assert_eq!(
            outcome.end,
            Some(RemoteEnd::Failed("no such folder".to_owned()))
        );
    }
}
