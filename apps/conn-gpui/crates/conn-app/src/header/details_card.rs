//! Top-right Thread Details inspector (`ThreadDetailsCard.tsx`, `ThreadDetailsPanel.tsx`,
//! `ThreadDetailsSection.tsx`, `threadDetailsPanelStyles.ts`).
//!
//! The far-right `SquareMenu` header toggle opens a `280px` glass card anchored under the
//! header (Conn's popover placement). Sections, in Conn's order:
//! - Workspace (no heading): environment + workspace path row (right-click `Copy full path`),
//!   `Open in <Editor>` split row, project scripts.
//! - Version Control: branch row (right-click `Copy branch name`), linked PRs with
//!   `Show N more` / `Show less`, `Initialize Git` or `Changes +ins -del`.
//! - Automations: scheduled tasks bound to this thread.
//! - Subagents (`Subagents · N running`): parent / fork link, running subagents, and the
//!   collapsed `Previous agents` group.
//!
//! Out of scope here (tracked in `docs/parity/shell-sidebar.md` §8): inline placement and
//! 3-tier density, the visibility customizer, branch picker, git quick actions and dialogs,
//! Servers, workflow rows, remote delegated rows, and the context meter.

use conn_contract::{ScheduledTaskRunStatus, VcsStatusResult};
use conn_state::providers::ModelCatalog;
use conn_state::{
    AgentWakeup, ScheduledTask, ShellState, ThreadShell, ThreadState, TimelineEntry, WakeupContext,
    WakeupKind, schedule_label,
};
use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Hsla, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, anchored, deferred, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;
use crate::icons;
use crate::panels::chrome::{ConnTooltipExt as _, FloatingSurfaceExt as _};
use crate::panels::header::dropdown_glass_shadow;
use crate::sidebar::thread_list::{current_unix_secs, middle_truncate};
use crate::theme::{hsla, hsla_alpha};

/// `--thread-details-panel-width`.
pub(crate) const DETAILS_CARD_WIDTH_PX: f32 = 280.0;
/// `THREAD_DETAILS_CARD_GAP`: the card's gap to the chat card's top and right edges.
pub(crate) const THREAD_DETAILS_CARD_GAP_PX: f32 = 12.0;
/// `rounded-bubble` (`--radius + 6px` = `14px`).
const CARD_RADIUS_PX: f32 = 14.0;
/// `h-8` rows, `rounded-lg`, `gap-2.5 px-2.5`.
const ROW_HEIGHT_PX: f32 = 32.0;
const ROW_RADIUS_PX: f32 = 8.0;
const ROW_GAP_PX: f32 = 10.0;
const ROW_PAD_X_PX: f32 = 10.0;
/// `text-ui` (`13px` / `20px`).
const UI_FONT_PX: f32 = 13.0;
const UI_LINE_PX: f32 = 20.0;
const ICON_PX: f32 = 16.0;
/// `THREAD_LINEAGE_INITIAL_COUNT`.
const LINEAGE_INITIAL_COUNT: usize = 6;
/// Linked PRs shown before `Show N more`.
const PR_INITIAL_COUNT: usize = 1;

/// An editor (or Finder) the `Open in` split button can launch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EditorTarget {
    Cursor,
    VsCode,
    Zed,
    Finder,
}

impl EditorTarget {
    pub(crate) const ALL: [Self; 4] = [Self::Cursor, Self::VsCode, Self::Zed, Self::Finder];

    #[must_use]
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Cursor => "Cursor",
            Self::VsCode => "VS Code",
            Self::Zed => "Zed",
            Self::Finder => "Finder",
        }
    }

    /// macOS application bundle name passed to `open -a` (`None` opens the folder in Finder).
    #[must_use]
    pub(crate) fn app_name(self) -> Option<&'static str> {
        match self {
            Self::Cursor => Some("Cursor"),
            Self::VsCode => Some("Visual Studio Code"),
            Self::Zed => Some("Zed"),
            Self::Finder => None,
        }
    }

    /// Editor brand marks are not in the asset set yet; editors use the `code` concept.
    fn icon(self) -> &'static str {
        match self {
            Self::Finder => "superhero/folder-open.svg",
            _ => "superhero/code.svg",
        }
    }

    /// Whether the app bundle exists in `/Applications` or `~/Applications`.
    #[must_use]
    pub(crate) fn installed(self) -> bool {
        let Some(app) = self.app_name() else {
            return true;
        };
        let bundle = format!("{app}.app");
        if std::path::Path::new("/Applications").join(&bundle).exists() {
            return true;
        }
        std::env::var_os("HOME").is_some_and(|home| {
            std::path::Path::new(&home)
                .join("Applications")
                .join(&bundle)
                .exists()
        })
    }
}

/// What a details-card right-click copies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DetailsCopyTarget {
    /// `Copy full path` on the workspace row.
    Path(String),
    /// `Copy branch name` on the branch row.
    Branch(String),
}

impl DetailsCopyTarget {
    fn label(&self) -> &'static str {
        match self {
            Self::Path(_) => "Copy full path",
            Self::Branch(_) => "Copy branch name",
        }
    }
}

/// Client state of the Thread Details card.
#[derive(Debug, Default)]
pub(crate) struct ThreadDetailsState {
    pub(crate) open: bool,
    /// Thread the loaded data belongs to.
    pub(crate) loaded_for: Option<String>,
    pub(crate) vcs: Option<VcsStatusResult>,
    pub(crate) vcs_loading: bool,
    pub(crate) tasks: Vec<ScheduledTask>,
    pub(crate) tasks_error: Option<String>,
    pub(crate) task_history: Option<crate::app::details_tasks::TaskHistoryRead>,
    /// The live scheduled-tasks stream of the open thread's environment.
    pub(crate) schedules: Option<crate::app::details_schedules::ScheduleSubscription>,
    pub(crate) busy_task_id: Option<String>,
    pub(crate) git_init_pending: bool,
    pub(crate) prs_expanded: bool,
    pub(crate) previous_agents_expanded: bool,
    pub(crate) open_in_menu_open: bool,
    pub(crate) scripts_menu_open: bool,
    pub(crate) preferred_editor: Option<EditorTarget>,
    pub(crate) copy_menu: Option<(DetailsCopyTarget, Point<Pixels>)>,
}

impl ThreadDetailsState {
    /// The preferred editor, else the first installed one (Finder last).
    #[must_use]
    pub(crate) fn editor(&self) -> EditorTarget {
        EditorTarget::resolve(self.preferred_editor)
    }
}

impl EditorTarget {
    /// `preferred`, else the first installed editor (Finder last).
    #[must_use]
    pub(crate) fn resolve(preferred: Option<Self>) -> Self {
        preferred.unwrap_or_else(|| {
            Self::ALL
                .into_iter()
                .find(|e| e.installed())
                .unwrap_or(Self::Finder)
        })
    }
}

/// Working directory the card's git rows use: the worktree, else the project root.
#[must_use]
pub(crate) fn thread_cwd(shell: &ShellState, thread: &ThreadShell) -> Option<String> {
    thread
        .worktree_path
        .clone()
        .filter(|p| !p.is_empty())
        .or_else(|| {
            shell
                .project(&thread.project_id)
                .map(|p| p.workspace_root.clone())
                .filter(|p| !p.is_empty())
        })
}

/// Where a child agent is in its run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentState {
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
    Idle,
}

impl AgentState {
    fn is_live(self) -> bool {
        matches!(self, Self::Running | Self::Waiting)
    }

    fn text(self) -> &'static str {
        match self {
            Self::Running => "Running",
            Self::Waiting => "Waiting",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Stopped => "Stopped",
            Self::Idle => "Idle",
        }
    }

    fn dot(self, tokens: &Tokens) -> Hsla {
        match self {
            Self::Running | Self::Waiting => hsla(tokens.info),
            Self::Failed => hsla(tokens.destructive),
            Self::Done => hsla(tokens.success),
            Self::Stopped | Self::Idle => hsla_alpha(tokens.muted_foreground, 0.45),
        }
    }

    fn from_shell(status: conn_contract::OrchestrationV2ShellThreadStatus) -> Self {
        use conn_contract::OrchestrationV2ShellThreadStatus as S;
        match status {
            S::Preparing | S::Queued | S::Starting | S::Running => Self::Running,
            S::Waiting => Self::Waiting,
            S::Completed => Self::Done,
            S::Failed => Self::Failed,
            S::Interrupted | S::Cancelled | S::RolledBack => Self::Stopped,
            S::Idle => Self::Idle,
        }
    }

    fn from_item(status: conn_state::TurnItemStatus) -> Self {
        use conn_state::TurnItemStatus as S;
        match status {
            S::Pending | S::Running => Self::Running,
            S::Waiting => Self::Waiting,
            S::Completed => Self::Done,
            S::Failed => Self::Failed,
            S::Cancelled | S::Interrupted => Self::Stopped,
            S::Idle => Self::Idle,
        }
    }
}

/// One child of the thread: a native subagent, a `delegate_task` child, or a child that runs on
/// another linked environment (`ThreadRelationshipsControl.tsx`, `SubagentTimelineLink`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentRow {
    /// Stable id for element ids: the child thread, else the timeline entry.
    pub(crate) key: String,
    /// The thread a click opens; empty when the child has none yet.
    pub(crate) thread_id: String,
    /// The linked environment the child runs on; `None` is the thread's own environment.
    pub(crate) environment_id: Option<String>,
    /// `on <label>` for a child on another environment.
    pub(crate) environment_label: Option<String>,
    pub(crate) title: String,
    /// Provider driver or instance id, for the provider mark.
    pub(crate) provider: String,
    /// `<model> · <effort>`.
    pub(crate) model: Option<String>,
    pub(crate) state: AgentState,
    pub(crate) elapsed: Option<String>,
}

impl AgentRow {
    /// `on nick · Opus 5.5 · medium`.
    pub(crate) fn meta(&self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        parts.extend(self.environment_label.as_ref().map(|l| format!("on {l}")));
        parts.extend(self.model.clone());
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

/// Lineage rows derived from the shell and the thread's timeline.
#[derive(Debug, Default)]
pub(crate) struct Lineage<'a> {
    pub(crate) parent: Option<&'a ThreadShell>,
    pub(crate) is_fork: bool,
    pub(crate) running: Vec<AgentRow>,
    pub(crate) previous: Vec<AgentRow>,
}

impl Lineage<'_> {
    #[must_use]
    pub(crate) fn failed_count(&self) -> usize {
        self.previous
            .iter()
            .filter(|t| t.state == AgentState::Failed)
            .count()
    }

    #[must_use]
    pub(crate) fn is_empty(&self) -> bool {
        self.parent.is_none() && self.running.is_empty() && self.previous.is_empty()
    }

    /// `Subagents · N running` when children run, else `Subagents` (Nick, #315: was `Lineage`).
    #[must_use]
    pub(crate) fn title(&self) -> String {
        if self.running.is_empty() {
            "Subagents".to_owned()
        } else {
            format!("Subagents · {} running", self.running.len())
        }
    }
}

/// The model text of the subagent behind timeline entry `entry_id`.
fn entry_model(
    timeline: Option<&ThreadState>,
    entry_id: &str,
    catalog: &ModelCatalog,
) -> Option<String> {
    let timeline = timeline?;
    let model = timeline
        .subagent_of_entry
        .get(entry_id)
        .and_then(|subagent| timeline.subagent_models.get(subagent))
        .or_else(|| timeline.subagent_models.get(entry_id))?;
    crate::chat::subagent_model_text(catalog, model)
}

/// `13s`, `2m 4s`: how long a child ran, or has run, from its ISO-8601 start and end.
fn agent_elapsed(
    live: bool,
    started_at: Option<&str>,
    completed_at: Option<&str>,
    now_secs: i64,
) -> Option<String> {
    let start = started_at.and_then(conn_state::parse_iso8601_epoch_ms)?;
    let end = if live {
        now_secs.saturating_mul(1000)
    } else {
        conn_state::parse_iso8601_epoch_ms(completed_at?)?
    };
    u64::try_from(end - start)
        .ok()
        .map(conn_state::format_duration)
}

/// A child that has a thread in the shell.
fn shell_agent(
    child: &ThreadShell,
    timeline: Option<&ThreadState>,
    catalog: &ModelCatalog,
    now_secs: i64,
) -> AgentRow {
    let entry = timeline.and_then(|t| {
        t.entries.iter().find_map(|e| match e {
            TimelineEntry::Subagent {
                id,
                child_thread_id,
                started_at,
                completed_at,
                ..
            } if child_thread_id.as_deref() == Some(child.id.as_str()) => {
                Some((id.as_str(), started_at.as_deref(), completed_at.as_deref()))
            }
            _ => None,
        })
    });
    let live = crate::sidebar::thread_list::resolve_row_status(child).is_some_and(|s| {
        matches!(
            s,
            crate::sidebar::thread_list::RowStatus::Working
                | crate::sidebar::thread_list::RowStatus::Goal
                | crate::sidebar::thread_list::RowStatus::Waiting
        )
    });
    let state = match AgentState::from_shell(child.status) {
        // A row the sidebar shows as working is running, whatever its last run says.
        s if live && !s.is_live() => AgentState::Running,
        s => s,
    };
    let run_started = child
        .activity_run_started_at
        .as_ref()
        .and_then(Option::as_deref)
        .or_else(|| {
            child
                .latest_run_started_at
                .as_ref()
                .and_then(Option::as_deref)
        });
    let run_completed = child
        .latest_run_completed_at
        .as_ref()
        .and_then(Option::as_deref);
    let elapsed = if state.is_live() {
        agent_elapsed(true, run_started, None, now_secs)
    } else {
        agent_elapsed(false, run_started, run_completed, now_secs)
            .or_else(|| entry.and_then(|(_, s, c)| agent_elapsed(false, s, c, now_secs)))
    };
    // The child's own selection first: the parent's subagent record can lack its options.
    let model = crate::chat::subagent_model_text(
        catalog,
        &conn_state::SubagentModel::from_selection(
            &child.provider_instance_id,
            &child.model_selection,
        ),
    )
    .or_else(|| entry.and_then(|(id, ..)| entry_model(timeline, id, catalog)));
    AgentRow {
        key: child.id.clone(),
        thread_id: child.id.clone(),
        environment_id: None,
        environment_label: None,
        title: child.title.clone(),
        provider: child.provider_instance_id.clone(),
        model,
        state,
        elapsed,
    }
}

/// Children the timeline lists but the shell does not: `delegate_task` children on another
/// linked environment (`remote_child`), and native subagents whose thread is not loaded.
fn timeline_agents(
    shell: &ShellState,
    timeline: Option<&ThreadState>,
    catalog: &ModelCatalog,
    now_secs: i64,
    seen: &mut std::collections::HashSet<String>,
) -> Vec<AgentRow> {
    let mut rows = Vec::new();
    for entry in timeline.into_iter().flat_map(|t| &t.entries) {
        let TimelineEntry::Subagent {
            id,
            child_thread_id,
            title,
            role,
            status,
            remote_child,
            started_at,
            completed_at,
            ..
        } = entry
        else {
            continue;
        };
        let (thread_id, environment_id, environment_label, title) = match remote_child {
            Some(remote) => (
                remote.thread_id.clone(),
                Some(remote.environment_id.clone()),
                Some(remote.label.clone()),
                remote
                    .title
                    .clone()
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| title.clone()),
            ),
            None => {
                let thread_id = child_thread_id.clone().unwrap_or_default();
                // A child the shell lists is a shell row, unless the card hides it on purpose.
                if let Some(child) = shell.find_thread(&thread_id) {
                    if child.deleted_at.is_none()
                        && child.lineage.side_chat != Some(true)
                        && seen.insert(child.id.clone())
                    {
                        rows.push(shell_agent(child, timeline, catalog, now_secs));
                    }
                    continue;
                }
                (thread_id, None, None, title.clone())
            }
        };
        let key = if thread_id.is_empty() {
            id.clone()
        } else {
            thread_id.clone()
        };
        if !seen.insert(key.clone()) {
            continue;
        }
        let state = AgentState::from_item(*status);
        rows.push(AgentRow {
            key,
            thread_id,
            environment_id,
            environment_label,
            title,
            provider: role.clone(),
            model: entry_model(timeline, id, catalog),
            state,
            elapsed: agent_elapsed(
                !conn_state::subagent_settled(*status),
                started_at.as_deref(),
                completed_at.as_deref(),
                now_secs,
            ),
        });
    }
    rows
}

/// Collects parent/fork and child agents for `thread`: the shell's children, then the children
/// only its timeline lists (the ones on another environment).
#[must_use]
pub(crate) fn resolve_lineage<'a>(
    shell: &'a ShellState,
    thread: &ThreadShell,
    timeline: Option<&ThreadState>,
    catalog: &ModelCatalog,
    now_secs: i64,
) -> Lineage<'a> {
    use conn_contract::OrchestrationV2AppThreadLineageRelationshipToParent as Rel;
    let fork_source = match &thread.forked_from {
        Some(conn_contract::OrchestrationV2TurnItemForkSource::Run(run)) => {
            Some(run.thread_id.as_str())
        }
        _ => None,
    };
    let parent_id = thread.lineage.parent_thread_id.as_deref().or(fork_source);
    let is_fork =
        fork_source.is_some() || matches!(thread.lineage.relationship_to_parent, Some(Rel::Fork));
    let mut lineage = Lineage {
        parent: parent_id.and_then(|id| shell.find_thread(id)),
        is_fork,
        ..Lineage::default()
    };
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for child in shell.threads.iter().chain(shell.archived_threads.iter()) {
        if child.deleted_at.is_some()
            || child.lineage.parent_thread_id.as_deref() != Some(thread.id.as_str())
            || child.lineage.side_chat == Some(true)
            || !seen.insert(child.id.clone())
        {
            continue;
        }
        rows.push(shell_agent(child, timeline, catalog, now_secs));
    }
    rows.extend(timeline_agents(
        shell, timeline, catalog, now_secs, &mut seen,
    ));
    for row in rows {
        if row.state.is_live() {
            lineage.running.push(row);
        } else {
            lineage.previous.push(row);
        }
    }
    lineage
}

/// `#number: title` labels for the thread's linked PRs, current first.
#[must_use]
pub(crate) fn pull_request_lines(thread: &ThreadShell) -> Vec<String> {
    let mut lines: Vec<String> = thread
        .pull_requests
        .as_deref()
        .unwrap_or_default()
        .iter()
        .rev()
        .map(|pr| match &pr.snapshot {
            Some(snapshot) => format!("#{}: {}", pr.number, snapshot.title),
            None => format!("#{}", pr.number),
        })
        .collect();
    if lines.is_empty()
        && let Some(pr) = thread
            .branch_pull_request
            .as_ref()
            .and_then(Option::as_ref)
            .or_else(|| thread.linked_pull_request.as_ref().and_then(Option::as_ref))
    {
        lines.push(format!("#{}", pr.number));
    }
    lines
}

/// Props for [`render_thread_details_card`].
pub(crate) struct DetailsCardProps<'a> {
    pub(crate) shell: &'a ShellState,
    pub(crate) thread: &'a ThreadShell,
    pub(crate) task_links: Option<&'a conn_state::ThreadTaskLinks>,
    /// The thread's timeline: its `subagent` rows list the children on other environments.
    pub(crate) timeline: Option<&'a ThreadState>,
    /// Names the models of child agents.
    pub(crate) catalog: &'a ModelCatalog,
    pub(crate) state: &'a ThreadDetailsState,
    pub(crate) environment_label: &'a str,
    pub(crate) max_height: f32,
    pub(crate) tokens: &'a Tokens,
}

fn row_base(
    id: impl Into<gpui_kit::ElementId>,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(ROW_GAP_PX))
        .w_full()
        .min_w_0()
        .h(px(ROW_HEIGHT_PX))
        .px(px(ROW_PAD_X_PX))
        .rounded(px(ROW_RADIUS_PX))
        .text_size(px(UI_FONT_PX))
        .line_height(px(UI_LINE_PX))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(hsla_alpha(tokens.foreground, 0.80))
}

fn label(text: impl Into<SharedString>) -> gpui_kit::Div {
    div().flex_1().min_w_0().truncate().child(text.into())
}

/// A card section exposed as an `AXGroup` (`ax_id` = `thread-details.<section>`).
fn section(
    ax_id: &'static str,
    ax_label: &'static str,
    title: Option<String>,
    separated: bool,
    actions: Option<AnyElement>,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let mut s = div()
        .id(ax_id)
        .a11y_group(ax_id, ax_label)
        .flex()
        .flex_col()
        .px(px(8.0))
        .pt(px(8.0))
        .pb(px(10.0));
    if separated {
        s = s.border_t_1().border_color(hsla(tokens.glass_divider));
    }
    if let Some(title) = title {
        let mut heading = div()
            .id(SharedString::from(format!("{ax_id}-heading")))
            .a11y(
                gpui_kit::Role::Heading,
                format!("{ax_id}.heading"),
                title.clone(),
            )
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .min_h(px(ROW_HEIGHT_PX))
            .mb(px(4.0))
            .px(px(ROW_PAD_X_PX))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(UI_FONT_PX))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(hsla(tokens.muted_foreground))
                    .child(title),
            );
        if let Some(actions) = actions {
            heading = heading.child(actions);
        }
        s = s.child(heading);
    }
    s
}

/// The `1px x 16px` `--glass-divider` hairline between split-row halves.
fn split_separator(group: SharedString, tokens: &Tokens) -> gpui_kit::Div {
    let divider = hsla(tokens.glass_divider);
    div()
        .h(px(16.0))
        .w(px(1.0))
        .flex_shrink_0()
        .group_hover(group, move |s| s.bg(divider))
}

fn small_menu(
    id: &'static str,
    ax_id: &'static str,
    ax_label: &'static str,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .a11y(gpui_kit::Role::Menu, ax_id, ax_label)
        .flex()
        .flex_col()
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(hsla(tokens.popover))
        .border_1()
        .border_color(hsla(tokens.foreground.with_alpha(0.08)))
        .shadow(vec![dropdown_glass_shadow(tokens)])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

fn menu_row(
    id: impl Into<gpui_kit::ElementId>,
    ax_id: impl Into<SharedString>,
    icon: &'static str,
    text: impl Into<SharedString>,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let highlight = hsla(tokens.shell_highlight);
    let text = text.into();
    div()
        .id(id)
        .a11y(gpui_kit::Role::MenuItem, ax_id, text.clone())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .min_h(px(28.0))
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(8.0))
        .cursor_pointer()
        .text_size(px(14.0))
        .line_height(px(20.0))
        .text_color(hsla(tokens.popover_foreground))
        .hover(move |s| s.bg(highlight))
        .child(icons::concept(
            icon,
            ICON_PX,
            hsla(tokens.muted_foreground).opacity(0.8),
        ))
        .child(div().flex_1().min_w_0().truncate().child(text))
}

/// Renders the anchored Thread Details card.
#[must_use]
pub(crate) fn render_thread_details_card(
    props: &DetailsCardProps<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> AnyElement {
    let tokens = props.tokens;
    let thread = props.thread;

    let mut body = div()
        .id("thread-details-scroll")
        .a11y_group("thread-details.scroll", "Thread details")
        .flex()
        .flex_col()
        .max_h(px(props.max_height))
        .overflow_y_scroll();

    // Workspace section.
    body = body.child(render_workspace_section(props, cx));

    // Version Control section.
    if let Some(vc) = render_version_control_section(props, cx) {
        body = body.child(vc);
    }

    let mut tasks_section = None;
    for (&id, title) in props.task_links.into_iter().flat_map(|tasks| &tasks.links) {
        let rows = tasks_section.take().unwrap_or_else(|| {
            section(
                "thread-details.linked-tasks",
                "Linked tasks",
                Some("Tasks".into()),
                true,
                None,
                tokens,
            )
        });
        let text = format!("#{id} · {title}");
        let hover = hsla(tokens.shell_highlight);
        tasks_section = Some(
            rows.child(
                row_base(SharedString::from(format!("details-task-{id}")), tokens)
                    .a11y_button(format!("thread-details.task.{id}"), text.clone())
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .conn_tooltip(title.to_owned(), tokens)
                    .on_click(cx.listener(move |app, _, window, cx| {
                        app.toggle_thread_details(window, cx);
                        app.open_task_in_panel(id, cx);
                    }))
                    .child(icons::concept(
                        "superhero/checklist.svg",
                        ICON_PX,
                        hsla(tokens.muted_foreground),
                    ))
                    .child(label(text))
                    .test_support(),
            ),
        );
    }
    body = body.when_some(tasks_section, |el, rows| el.child(rows));

    // Automations section (auto-hidden when nothing is bound and there is no error).
    let bound = bound_tasks(&props.state.tasks, &thread.id);
    if !bound.is_empty() || props.state.tasks_error.is_some() {
        body = body.child(render_automations_section(props, &bound, cx));
    }

    // Agent wakeups: what the agent set to wake itself, which no Conn scheduled task lists.
    let wakeups = thread_wakeups(props, current_unix_secs());
    if !wakeups.is_empty() {
        body = body.child(render_agent_wakeups_section(&wakeups, tokens));
    }

    // Lineage section.
    let lineage = resolve_lineage(
        props.shell,
        thread,
        props.timeline,
        props.catalog,
        current_unix_secs(),
    );
    if !lineage.is_empty() {
        body = body.child(render_lineage_section(props, &lineage, cx));
    }

    let mut card = div()
        .id("thread-details-card")
        .test_support()
        .a11y(
            gpui_kit::Role::Dialog,
            "header.details-card",
            "Thread details",
        )
        .w(px(DETAILS_CARD_WIDTH_PX))
        .rounded(px(CARD_RADIUS_PX))
        .overflow_hidden()
        .bg(hsla(match tokens.appearance {
            conn_theme::Appearance::Dark => tokens.shell_raised,
            conn_theme::Appearance::Light => tokens.popover,
        }))
        .border_1()
        .border_color(hsla(tokens.foreground.with_alpha(0.08)))
        .shadow(vec![dropdown_glass_shadow(tokens)])
        .floating_surface()
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .child(body);

    if let Some((target, position)) = &props.state.copy_menu {
        let text = match target {
            DetailsCopyTarget::Path(p) | DetailsCopyTarget::Branch(p) => p.clone(),
        };
        let menu = small_menu(
            "thread-details-copy-menu",
            "thread-details.copy-menu",
            "Copy menu",
            tokens,
        )
        .child(
            menu_row(
                "thread-details-copy-row",
                "thread-details.copy-menu.copy",
                "superhero/copy.svg",
                target.label(),
                tokens,
            )
            .on_click(cx.listener(move |app, _, _, cx| {
                cx.stop_propagation();
                app.copy_to_clipboard(text.clone(), cx);
                app.close_details_copy_menu(cx);
            })),
        );
        card = card.child(deferred(anchored().position(*position).child(menu)).with_priority(7));
    }
    card.into_any_element()
}

fn render_workspace_section(
    props: &DetailsCardProps<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let tokens = props.tokens;
    let thread = props.thread;
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let mut rows = div().flex().flex_col();

    // Environment / host + workspace row (`RunContextSelector`, locked for server threads).
    let path = thread_cwd(props.shell, thread).unwrap_or_default();
    let has_worktree = thread
        .worktree_path
        .as_deref()
        .is_some_and(|p| !p.is_empty());
    let workspace_icon = if has_worktree {
        "superhero/folder-git.svg"
    } else {
        "superhero/folder.svg"
    };
    let has_workspace = !path.is_empty();
    let project = props.shell.project(&thread.project_id);
    let copy_path = path.clone();
    let workspace_label = if path.is_empty() {
        "No workspace path".to_owned()
    } else {
        format!("Workspace {path}")
    };
    rows = rows.child(
        row_base("thread-details-environment", tokens)
            .a11y_group(
                "thread-details.environment",
                format!("Environment {}", props.environment_label),
            )
            .hover(move |s| s.bg(highlight))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    app.open_details_copy_menu(
                        DetailsCopyTarget::Path(copy_path.clone()),
                        event.position,
                        cx,
                    );
                }),
            )
            .conn_tooltip(
                if path.is_empty() {
                    "No workspace path".to_owned()
                } else {
                    path
                },
                tokens,
            )
            .child(
                div()
                    .id("thread-details-environment-host")
                    .a11y(
                        gpui_kit::Role::Label,
                        "thread-details.environment.host",
                        format!("Machine {}", props.environment_label),
                    )
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(ROW_GAP_PX))
                    .flex_1()
                    .min_w_0()
                    .child(icons::concept("superhero/desktop.svg", 18.0, muted))
                    .child(label(props.environment_label.to_owned())),
            )
            .child(
                div()
                    .id("thread-details-environment-workspace")
                    .a11y(
                        gpui_kit::Role::Image,
                        "thread-details.environment.workspace",
                        workspace_label,
                    )
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .child(icons::concept(workspace_icon, ICON_PX, muted))
                    .when_some(project, |row, project| {
                        row.child(div().min_w_0().truncate().child(project.title.clone()))
                    }),
            ),
    );

    if has_workspace {
        rows = rows.child(
            row_base("thread-details-open-files", tokens)
                .a11y_button("thread-details.files", "Open in Files")
                .cursor_pointer()
                .hover(move |s| s.bg(highlight))
                .on_click(cx.listener(|app, _, window, cx| {
                    app.toggle_thread_details(window, cx);
                    app.select_right_panel_tab(conn_state::RightPanelTab::Files, cx);
                }))
                .child(icons::concept("superhero/folder-open.svg", ICON_PX, muted))
                .child(label("Open in Files"))
                .test_support(),
        );
    }

    // `Open in <Editor>` split row (`OpenInPicker displayMode="panel"`).
    let editor = props.state.editor();
    let group = SharedString::from("details-open-in");
    let menu_open = props.state.open_in_menu_open;
    let mut split = div()
        .id("thread-details-open-in")
        .a11y_group("thread-details.open-in", "Open in editor")
        .group(group.clone())
        .relative()
        .flex()
        .flex_row()
        .items_center()
        .w_full()
        .h(px(ROW_HEIGHT_PX))
        .rounded(px(ROW_RADIUS_PX))
        .hover(move |s| s.bg(highlight))
        .when(menu_open, move |s| s.bg(highlight))
        .child(
            row_base("thread-details-open-in-primary", tokens)
                .a11y_button(
                    "thread-details.open-in.primary",
                    format!("Open in {}", editor.label()),
                )
                .flex_1()
                .rounded_r(px(0.0))
                .cursor_pointer()
                .on_click(cx.listener(move |app, _, _, cx| {
                    app.open_thread_in_editor(editor, cx);
                }))
                .child(icons::concept(editor.icon(), ICON_PX, muted))
                .child(label(format!("Open in {}", editor.label()))),
        )
        .child(split_separator(group, tokens))
        .child(
            div()
                .id("thread-details-open-in-chevron")
                .a11y_button("thread-details.open-in.menu-toggle", "Choose editor")
                .aria_expanded(menu_open)
                .flex()
                .items_center()
                .justify_center()
                .w(px(32.0))
                .h_full()
                .cursor_pointer()
                .on_click(cx.listener(|app, _, _, cx| {
                    cx.stop_propagation();
                    app.toggle_details_open_in_menu(cx);
                }))
                .child(icons::concept("superhero/chevron-down.svg", ICON_PX, muted)),
        );
    if menu_open {
        let mut menu = small_menu(
            "thread-details-open-in-menu",
            "thread-details.open-in.menu",
            "Editors",
            tokens,
        )
        .w_full();
        let installed: Vec<EditorTarget> = EditorTarget::ALL
            .into_iter()
            .filter(|e| e.installed())
            .collect();
        for target in installed {
            let mut row = menu_row(
                SharedString::from(format!("thread-details-editor-{}", target.label())),
                format!(
                    "thread-details.open-in.menu.{}",
                    target.label().to_lowercase().replace(' ', "-")
                ),
                target.icon(),
                target.label(),
                tokens,
            )
            .on_click(cx.listener(move |app, _, _, cx| {
                cx.stop_propagation();
                app.set_preferred_editor(target, cx);
            }));
            if target == editor {
                row = row.child(icons::concept("superhero/check.svg", 14.0, muted));
            }
            menu = menu.child(row);
        }
        split = split.child(
            div()
                .absolute()
                .top_full()
                .left_0()
                .right_0()
                .mt(px(4.0))
                .child(menu),
        );
    }
    rows = rows.child(split);

    // Project scripts (`ProjectScriptsControl displayMode="panel"`).
    if let Some(project) = props.shell.project(&thread.project_id) {
        if let Some(primary) = project.scripts.first() {
            let group = SharedString::from("details-scripts");
            let scripts_open = props.state.scripts_menu_open;
            let mut split = div()
                .id("thread-details-scripts")
                .a11y_group("thread-details.scripts", "Project scripts")
                .group(group.clone())
                .relative()
                .flex()
                .flex_row()
                .items_center()
                .w_full()
                .h(px(ROW_HEIGHT_PX))
                .rounded(px(ROW_RADIUS_PX))
                .hover(move |s| s.bg(highlight))
                .when(scripts_open, move |s| s.bg(highlight))
                .child(
                    row_base("thread-details-script-primary", tokens)
                        .a11y_button(
                            "thread-details.scripts.primary",
                            format!("Run {}", primary.name),
                        )
                        .flex_1()
                        .conn_tooltip(format!("Run {}", primary.name), tokens)
                        .child(icons::concept("superhero/terminal.svg", ICON_PX, muted))
                        .child(label(primary.name.clone())),
                )
                .child(split_separator(group, tokens))
                .child(
                    div()
                        .id("thread-details-scripts-chevron")
                        .a11y_button("thread-details.scripts.menu-toggle", "Choose script")
                        .aria_expanded(scripts_open)
                        .flex()
                        .items_center()
                        .justify_center()
                        .w(px(32.0))
                        .h_full()
                        .cursor_pointer()
                        .on_click(cx.listener(|app, _, _, cx| {
                            cx.stop_propagation();
                            app.toggle_details_scripts_menu(cx);
                        }))
                        .child(icons::concept("superhero/chevron-down.svg", ICON_PX, muted)),
                );
            if scripts_open {
                let mut menu = small_menu(
                    "thread-details-scripts-menu",
                    "thread-details.scripts.menu",
                    "Project scripts",
                    tokens,
                )
                .w_full();
                for (idx, script) in project.scripts.iter().enumerate() {
                    menu = menu.child(menu_row(
                        ("thread-details-script", idx),
                        format!("thread-details.scripts.menu.{idx}"),
                        "superhero/terminal.svg",
                        script.name.clone(),
                        tokens,
                    ));
                }
                split = split.child(
                    div()
                        .absolute()
                        .top_full()
                        .left_0()
                        .right_0()
                        .mt(px(4.0))
                        .child(menu),
                );
            }
            rows = rows.child(split);
        } else {
            rows = rows.child(
                row_base("thread-details-add-script", tokens)
                    .a11y_button("thread-details.scripts.add", "Add project script")
                    .conn_tooltip("Add project script", tokens)
                    .child(icons::concept("superhero/add.svg", ICON_PX, muted))
                    .child(label("Add project script")),
            );
        }
    }

    section(
        "thread-details.workspace",
        "Workspace",
        None,
        false,
        None,
        tokens,
    )
    .child(rows)
}

fn render_version_control_section(
    props: &DetailsCardProps<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> Option<gpui_kit::Stateful<gpui_kit::Div>> {
    let tokens = props.tokens;
    let thread = props.thread;
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let is_repo = props.state.vcs.as_ref().map(|v| v.is_repo);
    let mut rows = div().flex().flex_col();
    let mut any = false;

    // Branch row: the thread's branch, else the checkout's current ref.
    let branch = thread
        .branch
        .clone()
        .filter(|b| !b.is_empty())
        .or_else(|| props.state.vcs.as_ref().and_then(|v| v.ref_name.clone()));
    if is_repo != Some(false)
        && let Some(branch) = branch
    {
        any = true;
        let copy = branch.clone();
        let click_copy = branch.clone();
        rows = rows.child(
            row_base("thread-details-branch", tokens)
                .a11y_button(
                    "thread-details.branch",
                    format!("Copy branch name: {branch}"),
                )
                .cursor_pointer()
                .on_click(
                    cx.listener(move |app, _, _, cx| app.copy_to_clipboard(click_copy.clone(), cx)),
                )
                .hover(move |s| s.bg(highlight))
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        app.open_details_copy_menu(
                            DetailsCopyTarget::Branch(copy.clone()),
                            event.position,
                            cx,
                        );
                    }),
                )
                .conn_tooltip("Copy branch name", tokens)
                .child(icons::concept("superhero/branch.svg", ICON_PX, muted))
                .child(label(middle_truncate(&branch, 32)))
                .test_support(),
        );
    }

    // Linked PRs (`ThreadDetailsPrRows`).
    let prs = pull_request_lines(thread);
    if !prs.is_empty() {
        any = true;
        let expanded = props.state.prs_expanded;
        let shown = if expanded {
            prs.len()
        } else {
            PR_INITIAL_COUNT
        };
        for (idx, line) in prs.iter().take(shown).enumerate() {
            rows = rows.child(
                row_base(("thread-details-pr", idx), tokens)
                    .a11y_button(
                        format!("thread-details.pr.{idx}"),
                        format!("Pull request {line}"),
                    )
                    .cursor_pointer()
                    .hover(move |s| s.bg(highlight))
                    .on_click(cx.listener(|app, _, _, cx| {
                        app.select_right_panel_tab(conn_state::RightPanelTab::PullRequest, cx);
                    }))
                    .conn_tooltip(line.clone(), tokens)
                    .child(icons::concept(icons::PULL_REQUEST, ICON_PX, muted))
                    .child(label(line.clone())),
            );
        }
        let rest = prs.len().saturating_sub(PR_INITIAL_COUNT);
        if rest > 0 {
            rows = rows.child(
                row_base("thread-details-pr-toggle", tokens)
                    .a11y_button(
                        "thread-details.pr.toggle",
                        if expanded {
                            "Show fewer pull requests".to_owned()
                        } else {
                            format!("Show {rest} more pull requests")
                        },
                    )
                    .aria_expanded(expanded)
                    .cursor_pointer()
                    .text_color(muted)
                    .hover(move |s| s.bg(highlight))
                    .on_click(cx.listener(|app, _, _, cx| app.toggle_details_prs(cx)))
                    .child(icons::concept(
                        if expanded {
                            "superhero/chevron-up.svg"
                        } else {
                            "superhero/chevron-down.svg"
                        },
                        ICON_PX,
                        muted,
                    ))
                    .child(label(if expanded {
                        "Show less".to_owned()
                    } else {
                        format!("Show {rest} more")
                    })),
            );
        }
    }

    // Git actions: `Initialize Git` for plain folders, else the `Changes` summary row.
    match &props.state.vcs {
        Some(vcs) if !vcs.is_repo => {
            any = true;
            let pending = props.state.git_init_pending;
            rows = rows.child(
                row_base("thread-details-init-git", tokens)
                    .a11y_button("thread-details.init-git", "Initialize Git")
                    .cursor_pointer()
                    .hover(move |s| s.bg(highlight))
                    .on_click(cx.listener(|app, _, _, cx| app.init_git_for_thread(cx)))
                    .child(icons::concept("superhero/branch-add.svg", ICON_PX, muted))
                    .child(label(if pending {
                        "Initializing..."
                    } else {
                        "Initialize Git"
                    })),
            );
        }
        Some(vcs) => {
            any = true;
            let ins = vcs.working_tree.insertions;
            let del = vcs.working_tree.deletions;
            let add_color = if ins > 0 {
                hsla(tokens.diff_added)
            } else {
                muted
            };
            let del_color = if del > 0 {
                hsla(tokens.diff_removed)
            } else {
                muted
            };
            rows = rows.child(
                row_base("thread-details-changes", tokens)
                    .a11y_button("thread-details.changes", format!("Changes +{ins} -{del}"))
                    .cursor_pointer()
                    .hover(move |s| s.bg(highlight))
                    .on_click(cx.listener(|app, _, _, cx| {
                        app.select_right_panel_tab(conn_state::RightPanelTab::Diff, cx);
                    }))
                    .child(icons::concept("superhero/file-diff.svg", ICON_PX, muted))
                    .child(label("Changes"))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(6.0))
                            .flex_shrink_0()
                            .child(div().text_color(add_color).child(format!("+{ins}")))
                            .child(div().text_color(del_color).child(format!("-{del}"))),
                    ),
            );
        }
        None => {}
    }

    any.then(|| {
        section(
            "thread-details.version-control",
            "Version Control",
            None,
            true,
            None,
            tokens,
        )
        .child(rows)
    })
}

/// The tasks bound to `thread_id` (`ThreadAutomationsPanel`: `task.threadId === threadId`).
#[must_use]
pub(crate) fn bound_tasks<'a>(
    tasks: &'a [ScheduledTask],
    thread_id: &str,
) -> Vec<&'a ScheduledTask> {
    tasks
        .iter()
        .filter(|task| task.thread_id.as_deref() == Some(thread_id))
        .collect()
}

/// Conn's `relativeLabel` for a time `diff_secs` from now: `in 5m`, `in 3h`, `2h ago`.
fn relative_label(diff_secs: i64) -> String {
    if diff_secs <= 0 {
        let elapsed = diff_secs.saturating_neg();
        return match elapsed {
            0..60 => "just now".to_owned(),
            60..3_600 => format!("{}m ago", elapsed / 60),
            3_600..86_400 => format!("{}h ago", elapsed / 3_600),
            _ => format!("{}d ago", elapsed / 86_400),
        };
    }
    let minutes = diff_secs.saturating_add(59) / 60;
    if minutes < 2 {
        return "in under a minute".to_owned();
    }
    if minutes < 60 {
        return format!("in {minutes}m");
    }
    let hours = (minutes + 30) / 60;
    if hours < 24 {
        return format!("in {hours}h");
    }
    format!("in {}d", (hours + 12) / 24)
}

/// The schedule line of a task row (`taskScheduleLine`): the schedule, then the policy that
/// blocks it, else `next in 3h`, else `paused`.
#[must_use]
pub(crate) fn task_schedule_line(task: &ScheduledTask, now_secs: i64) -> String {
    let mut line = schedule_label(&task.schedule);
    if let Some(reason) = &task.blocked_by_policy {
        line.push_str(&format!(" · {reason}"));
    } else if task.enabled {
        let next = task
            .next_run_at
            .as_deref()
            .and_then(crate::sidebar::thread_list::parse_iso8601_unix_secs);
        if let Some(next) = next {
            line.push_str(&format!(" · next {}", relative_label(next - now_secs)));
        }
    } else {
        line.push_str(" · paused");
    }
    line
}

/// The last run of a task in words (`RUN_STATUS_LABELS`), with its age and error.
#[must_use]
pub(crate) fn task_last_run_text(task: &ScheduledTask, now_secs: i64) -> String {
    let status = match task.last_run_status {
        ScheduledTaskRunStatus::Never => return "Never run".to_owned(),
        ScheduledTaskRunStatus::Running => "Running",
        ScheduledTaskRunStatus::Succeeded => "Last run succeeded",
        ScheduledTaskRunStatus::Failed => "Last run failed",
    };
    let mut text = status.to_owned();
    let at = task
        .last_run_at
        .as_deref()
        .and_then(crate::sidebar::thread_list::parse_iso8601_unix_secs);
    if let Some(at) = at
        && task.last_run_status != ScheduledTaskRunStatus::Running
    {
        text.push_str(&format!(" {}", relative_label(at - now_secs)));
    }
    if let Some(error) = task.last_run_error.as_deref().filter(|e| !e.is_empty()) {
        text.push_str(&format!(": {error}"));
    }
    text
}

fn status_dot_color(status: ScheduledTaskRunStatus, tokens: &Tokens) -> Hsla {
    match status {
        ScheduledTaskRunStatus::Never => hsla_alpha(tokens.muted_foreground, 0.40),
        ScheduledTaskRunStatus::Running => hsla(tokens.info),
        ScheduledTaskRunStatus::Succeeded => hsla(tokens.success),
        ScheduledTaskRunStatus::Failed => hsla(tokens.destructive),
    }
}

fn render_automations_section(
    props: &DetailsCardProps<'_>,
    tasks: &[&ScheduledTask],
    cx: &mut Context<'_, ConnApp>,
) -> AnyElement {
    let tokens = props.tokens;
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let manage = div()
        .id("thread-details-manage-tasks")
        .a11y_button(
            "thread-details.automations.manage",
            "Manage scheduled tasks",
        )
        .flex()
        .items_center()
        .justify_center()
        .size(px(24.0))
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(highlight))
        .on_click(cx.listener(|app, _, window, cx| {
            app.open_settings_page(
                Some(crate::settings::SettingsPage::ScheduledTasks),
                window,
                cx,
            );
        }))
        .conn_tooltip("Manage scheduled tasks", tokens)
        .child(icons::concept("superhero/adjust.svg", ICON_PX, muted))
        .test_support()
        .into_any_element();
    let mut list = div().flex().flex_col();
    for task in tasks {
        let dot = status_dot_color(task.last_run_status, tokens);
        let now = current_unix_secs();
        let schedule = task_schedule_line(task, now);
        let last_run = task_last_run_text(task, now);
        let busy = props.state.busy_task_id.as_deref() == Some(task.id.as_str());
        let running = task.last_run_status == ScheduledTaskRunStatus::Running;
        let is_webhook = matches!(task.schedule, conn_state::ScheduledTaskSchedule::Webhook(_));
        let run_id = task.id.clone();
        let toggle_id = task.id.clone();
        let enabled = task.enabled;
        let mut row = div()
            .id(SharedString::from(format!(
                "thread-details-task-{}",
                task.id
            )))
            .a11y_group(
                format!("thread-details.task.{}", task.id),
                format!("Scheduled task {}, {schedule}, {last_run}", task.title),
            )
            .test_support()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(ROW_GAP_PX))
            .w_full()
            .px(px(ROW_PAD_X_PX))
            .py(px(6.0))
            .rounded(px(ROW_RADIUS_PX))
            .hover(move |s| s.bg(highlight))
            .conn_tooltip(format!("{}\n{schedule}\n{last_run}", task.title), tokens)
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(icons::concept("superhero/scheduled.svg", ICON_PX, muted))
                    // The shared status dot with its card-coloured cutout ring (Nick, #317).
                    .child(crate::panels::chrome::status_dot_cutout(
                        dot,
                        hsla(tokens.popover),
                        None,
                        false,
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(14.0))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(hsla_alpha(tokens.foreground, 0.80))
                            .child(task.title.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.0))
                            .text_color(muted)
                            .child(schedule.clone()),
                    ),
            );
        if !is_webhook {
            let disabled = busy || running;
            row = row.child(
                div()
                    .id(SharedString::from(format!(
                        "thread-details-task-run-{}",
                        task.id
                    )))
                    .a11y_button(
                        format!("thread-details.task.{}.run", task.id),
                        format!("Run {} now", task.title),
                    )
                    .test_support()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .rounded(px(ROW_RADIUS_PX))
                    .when(disabled, |s| s.opacity(0.5))
                    .when(!disabled, |s| {
                        s.cursor_pointer()
                            .hover(move |s| s.bg(highlight))
                            .on_click(cx.listener(move |app, _, _, cx| {
                                cx.stop_propagation();
                                app.run_scheduled_task_now(run_id.clone(), cx);
                            }))
                    })
                    .conn_tooltip("Run now", tokens)
                    .child(icons::concept("superhero/play.svg", 14.0, muted)),
            );
        }
        let switch_label = if enabled {
            format!("Pause {}", task.title)
        } else {
            format!("Resume {}", task.title)
        };
        row = row.child(
            div()
                .id(SharedString::from(format!(
                    "thread-details-task-toggle-{}",
                    task.id
                )))
                .a11y_switch(
                    SharedString::from(format!("thread-details.task.{}.enabled", task.id)),
                    switch_label,
                    enabled,
                )
                .test_support()
                .child(crate::settings::controls::pill_switch(
                    SharedString::from(format!("thread-details-task-switch-{}", task.id)),
                    enabled,
                    tokens,
                    {
                        let entity = cx.entity();
                        move |_, cx| {
                            entity.update(cx, |app, cx| {
                                app.set_scheduled_task_enabled(toggle_id.clone(), !enabled, cx);
                            });
                        }
                    },
                )),
        );
        list = list.child(row);
    }
    let mut s = section(
        "thread-details.automations",
        "Automations",
        Some("Automations".to_owned()),
        true,
        Some(manage),
        tokens,
    )
    .test_support()
    .child(div().max_h(px(216.0)).child(list));
    if let Some(error) = &props.state.tasks_error {
        s = s.child(
            div()
                .id("thread-details-automations-error")
                .a11y(
                    gpui_kit::Role::Alert,
                    "thread-details.automations.error",
                    format!("Automations error: {error}"),
                )
                .px(px(ROW_PAD_X_PX))
                .text_size(px(11.0))
                .text_color(hsla(tokens.destructive))
                .child(error.clone()),
        );
    }
    s.into_any_element()
}

/// The wakeups the agent set for itself on this thread: from its own timeline and the shell's
/// background roster, so a linked-environment thread reads its own environment's.
#[must_use]
pub(crate) fn thread_wakeups(props: &DetailsCardProps<'_>, now_secs: i64) -> Vec<AgentWakeup> {
    let Some(timeline) = props.timeline else {
        return Vec::new();
    };
    let pending = props
        .thread
        .pending_background_tasks
        .as_ref()
        .and_then(Option::as_ref)
        .map_or(&[][..], Vec::as_slice);
    timeline.agent_wakeups(&WakeupContext {
        now_ms: now_secs.saturating_mul(1_000),
        pending,
        provider: &props.thread.provider_instance_id,
        driver: props
            .catalog
            .driver_for_instance(&props.thread.provider_instance_id),
    })
}

/// `Wakeup`, `Loop`, `Cron` or `Timer`.
fn wakeup_kind_label(kind: WakeupKind) -> &'static str {
    match kind {
        WakeupKind::Wakeup => "Wakeup",
        WakeupKind::Loop => "Loop",
        WakeupKind::Cron => "Cron",
        WakeupKind::Timer => "Timer",
    }
}

/// When the next wake is: `next in 12m`, `next in 3h (est.)`, `due now`, else the cron schedule.
fn wakeup_when(wakeup: &AgentWakeup, now_secs: i64) -> String {
    let Some(due_ms) = wakeup.due_ms else {
        return wakeup
            .schedule
            .clone()
            .unwrap_or_else(|| "time unknown".to_owned());
    };
    let diff = due_ms.div_euclid(1_000).saturating_sub(now_secs);
    let mut when = if diff <= 0 {
        "due now".to_owned()
    } else {
        format!("next {}", relative_label(diff))
    };
    if wakeup.estimated {
        when.push_str(" (est.)");
    }
    when
}

/// The second line of a wakeup row: what it is, whether it recurs, and when it wakes:
/// `Wakeup · one-off · next in 12m (est.)`, `Cron · recurring · Every 5 minutes`.
#[must_use]
pub(crate) fn wakeup_line(wakeup: &AgentWakeup, now_secs: i64) -> String {
    let repeats = if wakeup.recurring {
        "recurring"
    } else {
        "one-off"
    };
    format!(
        "{} · {repeats} · {}",
        wakeup_kind_label(wakeup.kind),
        wakeup_when(wakeup, now_secs)
    )
}

/// The `Agent wakeups` section. The rows are read-only: the server cannot cancel a wakeup the
/// agent's own tools set.
fn render_agent_wakeups_section(wakeups: &[AgentWakeup], tokens: &Tokens) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let now = current_unix_secs();
    let mut list = div().flex().flex_col();
    for wakeup in wakeups {
        let line = wakeup_line(wakeup, now);
        let note = if wakeup.estimated {
            "\nThe time is an estimate. Conn cannot cancel this wakeup."
        } else {
            "\nConn cannot cancel this wakeup."
        };
        list = list.child(
            div()
                .id(SharedString::from(format!(
                    "thread-details-wakeup-{}",
                    wakeup.key
                )))
                .a11y_group(
                    format!("thread-details.agent-wakeup.{}", wakeup.key),
                    format!("Agent wakeup {}, {line}", wakeup.title),
                )
                .test_support()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(ROW_GAP_PX))
                .w_full()
                .px(px(ROW_PAD_X_PX))
                .py(px(6.0))
                .rounded(px(ROW_RADIUS_PX))
                .hover(move |s| s.bg(highlight))
                .conn_tooltip(format!("{}\n{line}{note}", wakeup.title), tokens)
                .child(icons::concept("superhero/scheduled.svg", ICON_PX, muted))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .text_size(px(14.0))
                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                .text_color(hsla_alpha(tokens.foreground, 0.80))
                                .child(wakeup.title.clone()),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(11.0))
                                .text_color(muted)
                                .child(line),
                        ),
                ),
        );
    }
    section(
        "thread-details.agent-wakeups",
        "Agent wakeups",
        Some("Agent wakeups".to_owned()),
        true,
        None,
        tokens,
    )
    .test_support()
    .child(div().max_h(px(216.0)).child(list))
    .into_any_element()
}

fn lineage_row(
    id: SharedString,
    ax_id: String,
    child: &ThreadShell,
    icon: AnyElement,
    trailing: Option<String>,
    props: &DetailsCardProps<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let tokens = props.tokens;
    let highlight = hsla(tokens.shell_highlight);
    let muted = hsla(tokens.muted_foreground);
    let thread_id = child.id.clone();
    let mut row = row_base(id, tokens)
        .a11y_button(ax_id, format!("Open thread {}", child.title))
        .cursor_pointer()
        .hover(move |s| s.bg(highlight))
        .on_click(cx.listener(move |app, _, _, cx| {
            app.select_thread(thread_id.clone(), cx);
        }))
        .conn_tooltip(child.title.clone(), tokens)
        .child(icon)
        .child(label(child.title.clone()));
    if let Some(trailing) = trailing {
        row = row.child(
            div()
                .flex_shrink_0()
                .text_color(muted)
                .font_weight(gpui_kit::FontWeight::NORMAL)
                .child(trailing),
        );
    }
    row
}

/// Provider icon with the `6px` status dot + `2px` cutout ring (`ThreadRelationshipIcon`).
/// A provider the app has no mark for shows the robot (`superhero/agent.svg`).
fn agent_icon(provider: &str, state: AgentState, tokens: &Tokens) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let mark = if provider.is_empty() {
        icons::concept("superhero/agent.svg", ICON_PX, muted).into_any_element()
    } else {
        icons::provider_mark(provider, ICON_PX, muted)
    };
    div()
        .relative()
        .flex_shrink_0()
        .child(mark)
        // Top right, as on the sidebar rows and subagent cards (Nick, #314).
        .child(crate::panels::chrome::status_dot_cutout(
            state.dot(tokens),
            hsla(tokens.popover),
            None,
            false,
        ))
        .into_any_element()
}

/// A child agent row: provider mark with status dot, the title over `on <env> · <model> ·
/// <effort>`, and the run time (else the state) at the right. A click opens the child's
/// thread, on its own environment when it runs on another one.
fn agent_row(
    id: SharedString,
    ax_id: String,
    agent: &AgentRow,
    props: &DetailsCardProps<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> AnyElement {
    let tokens = props.tokens;
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let mut text = div().flex().flex_col().flex_1().min_w_0().child(
        div()
            .min_w_0()
            .truncate()
            .text_color(hsla_alpha(tokens.foreground, 0.80))
            .child(agent.title.clone()),
    );
    if let Some(meta) = agent.meta() {
        text = text.child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(12.0))
                .line_height(px(16.0))
                .font_weight(gpui_kit::FontWeight::NORMAL)
                .text_color(muted)
                .child(meta),
        );
    }
    let trailing = agent
        .elapsed
        .clone()
        .unwrap_or_else(|| agent.state.text().to_owned());
    let row = row_base(id, tokens)
        .h_auto()
        .min_h(px(ROW_HEIGHT_PX))
        .py(px(4.0))
        .conn_tooltip(agent.title.clone(), tokens)
        .child(agent_icon(&agent.provider, agent.state, tokens))
        .child(text)
        .child(
            div()
                .flex_shrink_0()
                .text_color(muted)
                .font_weight(gpui_kit::FontWeight::NORMAL)
                .child(trailing),
        );
    if agent.thread_id.is_empty() {
        // No thread to open yet.
        return row
            .a11y_group(ax_id, format!("Agent {}", agent.title))
            .test_support()
            .into_any_element();
    }
    let (thread_id, environment_id) = (agent.thread_id.clone(), agent.environment_id.clone());
    row.a11y_button(ax_id, format!("Open thread {}", agent.title))
        .cursor_pointer()
        .hover(move |s| s.bg(highlight))
        .on_click(cx.listener(move |app, _, _, cx| match &environment_id {
            Some(environment) => app.open_remote_child(environment, &thread_id, cx),
            None => app.select_thread(thread_id.clone(), cx),
        }))
        .test_support()
        .into_any_element()
}

fn render_lineage_section(
    props: &DetailsCardProps<'_>,
    lineage: &Lineage<'_>,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let tokens = props.tokens;
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let mut list = div().flex().flex_col();

    if let Some(parent) = lineage.parent {
        let icon = if lineage.is_fork {
            "superhero/fork.svg"
        } else {
            "superhero/go-up-parent.svg"
        };
        list = list.child(lineage_row(
            SharedString::from("thread-details-parent"),
            "thread-details.lineage.parent".to_owned(),
            parent,
            icons::concept(icon, ICON_PX, muted).into_any_element(),
            None,
            props,
            cx,
        ));
    }
    for (idx, agent) in lineage.running.iter().enumerate() {
        list = list.child(agent_row(
            SharedString::from(format!("thread-details-running-{idx}")),
            format!("thread-details.lineage.running.{}", agent.key),
            agent,
            props,
            cx,
        ));
    }

    if !lineage.previous.is_empty() {
        let expanded = props.state.previous_agents_expanded;
        let failed = lineage.failed_count();
        let mut trigger = row_base("thread-details-previous-agents", tokens)
            .a11y_button("thread-details.lineage.previous-agents", "Previous agents")
            .aria_expanded(expanded)
            .cursor_pointer()
            .hover(move |s| s.bg(highlight))
            .on_click(cx.listener(|app, _, _, cx| app.toggle_details_previous_agents(cx)))
            .child(icons::concept("superhero/agent.svg", ICON_PX, muted))
            .child(label("Previous agents"));
        if failed > 0 {
            trigger = trigger.child(
                div()
                    .flex_shrink_0()
                    .text_color(hsla(tokens.destructive))
                    .child(format!("{failed} failed")),
            );
        }
        if !expanded {
            trigger = trigger.child(
                div()
                    .flex_shrink_0()
                    .text_color(muted)
                    .child(lineage.previous.len().to_string()),
            );
        }
        trigger = trigger.child(icons::concept(
            if expanded {
                "superhero/chevron-down.svg"
            } else {
                "superhero/chevron-right.svg"
            },
            ICON_PX,
            muted,
        ));
        list = list.child(trigger.test_support());
        if expanded {
            for (idx, agent) in lineage
                .previous
                .iter()
                .take(LINEAGE_INITIAL_COUNT * 4)
                .enumerate()
            {
                list = list.child(agent_row(
                    SharedString::from(format!("thread-details-previous-{idx}")),
                    format!("thread-details.lineage.previous.{}", agent.key),
                    agent,
                    props,
                    cx,
                ));
            }
        }
    }

    section(
        "thread-details.lineage",
        "Subagents",
        Some(lineage.title()),
        true,
        None,
        tokens,
    )
    .child(div().max_h(px(216.0)).child(list))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_labels_match_conn() {
        let labels: Vec<&str> = EditorTarget::ALL.iter().map(|e| e.label()).collect();
        assert_eq!(labels, vec!["Cursor", "VS Code", "Zed", "Finder"]);
        assert!(
            EditorTarget::Finder.installed(),
            "Finder is always available"
        );
        assert_eq!(EditorTarget::Finder.app_name(), None);
    }

    #[test]
    fn lineage_title_counts_running() {
        let empty = Lineage::default();
        assert_eq!(empty.title(), "Subagents");
        assert!(empty.is_empty());
    }

    #[test]
    fn details_icons_exist() {
        use gpui_kit::AssetSource as _;
        let assets = crate::superhero::AppAssets;
        for path in [
            "superhero/desktop.svg",
            "superhero/folder.svg",
            "superhero/folder-git.svg",
            "superhero/folder-open.svg",
            "superhero/code.svg",
            "superhero/chevron-down.svg",
            "superhero/chevron-up.svg",
            "superhero/chevron-right.svg",
            "superhero/terminal.svg",
            "superhero/add.svg",
            "superhero/branch.svg",
            "superhero/branch-add.svg",
            "superhero/file-diff.svg",
            "superhero/scheduled.svg",
            "superhero/play.svg",
            "superhero/adjust.svg",
            "superhero/fork.svg",
            "superhero/go-up-parent.svg",
            "superhero/agent.svg",
            "superhero/copy.svg",
        ] {
            assert!(assets.load(path).ok().flatten().is_some(), "{path} exists");
        }
    }
}
