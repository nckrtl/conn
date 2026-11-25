//! Environment-wide pull request inbox for the project rail.
use std::collections::{HashMap, HashSet};

use std::rc::Rc;

use conn_client::Connection;
use conn_contract::{
    PullRequestListCursors, PullRequestListEntry, PullRequestListInput, PullRequestListState,
    PullRequestListStatsInput, PullRequestRef, PullRequestState, PullRequestSummaryChecksState,
    rpc::pull_requests::{list, list_stats},
};
use conn_theme::Tokens;
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::{
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Entity, EventEmitter, IntoElement, KeyDownEvent, Render, SharedString,
    Subscription, Window, div, px,
};

use super::{
    host_diff::{self, CodeFileEntry},
    logic::{describe_rpc_error, format_relative_time, now_epoch_ms, unavailable_notice},
};
use crate::a11y::ConnA11yExt as _;
use crate::panels::empty_state::{self, EmptyAction, EmptyState, render_empty_state};
use crate::panels::{color::to_hsla, header::superhero_icon};
use crate::sidebar::render_project_monogram;

#[derive(Clone, Debug)]
pub(in crate::panels) struct OpenRequest(pub(in crate::panels) PullRequestListEntry);
impl EventEmitter<OpenRequest> for PullRequestInbox {}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Filter {
    All,
    #[default]
    Open,
    Running,
    Passing,
    Failing,
    Draft,
    Merged,
    Closed,
}
impl Filter {
    const ALL: [Self; 8] = [
        Self::All,
        Self::Open,
        Self::Running,
        Self::Passing,
        Self::Failing,
        Self::Draft,
        Self::Merged,
        Self::Closed,
    ];
    fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Open => "Open",
            Self::Running => "In progress",
            Self::Passing => "Checks passed",
            Self::Failing => "Checks failed",
            Self::Draft => "Draft",
            Self::Merged => "Merged",
            Self::Closed => "Closed",
        }
    }
    fn status(pr: &PullRequestListEntry) -> Self {
        match pr.state {
            PullRequestState::Merged => Self::Merged,
            PullRequestState::Closed => Self::Closed,
            PullRequestState::Open if pr.is_draft => Self::Draft,
            PullRequestState::Open => match pr.checks_state {
                Some(PullRequestSummaryChecksState::Passing) => Self::Passing,
                Some(PullRequestSummaryChecksState::Failing) => Self::Failing,
                Some(PullRequestSummaryChecksState::Pending) => Self::Running,
                None => Self::Open,
            },
        }
    }
    fn matches(self, pr: &PullRequestListEntry) -> bool {
        self == Self::All
            || (self == Self::Open && pr.state == PullRequestState::Open)
            || self == Self::status(pr)
    }
}
fn entry_key(pr: &PullRequestListEntry) -> String {
    format!(
        "{}/{}/{}#{}",
        pr.project_id, pr.host, pr.repository, pr.number
    )
}
fn reference(pr: &PullRequestListEntry) -> PullRequestRef {
    PullRequestRef {
        project_id: pr.project_id.clone(),
        host: Some(pr.host.clone()),
        expected_account_id: None,
        allow_stale: None,
        repository: pr.repository.clone(),
        number: pr.number,
    }
}
fn matches_query(pr: &PullRequestListEntry, query: &str) -> bool {
    query.is_empty()
        || [
            &pr.title,
            &pr.project_title,
            &pr.head_branch,
            &pr.repository,
            &pr.host,
        ]
        .into_iter()
        .any(|s| s.to_lowercase().contains(query))
        || format!("{}#{}", pr.repository, pr.number)
            .to_lowercase()
            .contains(query)
        || pr
            .author
            .as_ref()
            .is_some_and(|a| a.login.to_lowercase().contains(query))
        || pr
            .labels
            .iter()
            .any(|l| l.name.to_lowercase().contains(query))
}
struct ExpandedFiles {
    key: String,
    rows: Option<Result<Vec<CodeFileEntry>, String>>,
}

pub(in crate::panels) struct PullRequestInbox {
    tokens: Tokens,
    connection: Option<Connection>,
    active: bool,
    generation: u64,
    rows: Vec<PullRequestListEntry>,
    stats: HashMap<(String, String, i64), (i64, i64)>,
    next: PullRequestListCursors,
    error: Option<String>,
    /// The list call itself failed, as opposed to some projects in it.
    request_failed: bool,
    /// A list call has finished, so an empty list is real and not just not-yet-loaded.
    loaded: bool,
    truncated: bool,
    loading: bool,
    filter: Filter,
    query: String,
    search: Entity<InputState>,
    expanded: Option<ExpandedFiles>,
    _subscription: Subscription,
}
impl PullRequestInbox {
    pub(in crate::panels) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search pull requests"));
        let subscription = cx.subscribe(&search, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.query = input.read(cx).value().trim().to_lowercase();
                cx.notify();
            }
        });
        Self {
            tokens,
            connection,
            active: false,
            generation: 0,
            rows: Vec::new(),
            stats: HashMap::new(),
            next: PullRequestListCursors::new(),
            error: None,
            request_failed: false,
            loaded: false,
            truncated: false,
            loading: false,
            filter: Filter::default(),
            query: String::new(),
            search,
            expanded: None,
            _subscription: subscription,
        }
    }
    pub(in crate::panels) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }
    pub(in crate::panels) fn set_connection(
        &mut self,
        conn: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.generation = self.generation.wrapping_add(1);
        self.connection = conn;
        self.rows.clear();
        self.stats.clear();
        self.next.clear();
        self.error = None;
        self.request_failed = false;
        self.loaded = false;
        self.loading = false;
        self.expanded = None;
        self.truncated = false;
        if self.active {
            self.load(false, cx);
        }
        cx.notify();
    }
    pub(in crate::panels) fn set_active(&mut self, active: bool, cx: &mut Context<'_, Self>) {
        if self.active == active {
            return;
        }
        self.active = active;
        if active && !self.loading {
            self.load(false, cx);
        }
    }
    fn load(&mut self, more: bool, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        if self.loading {
            return;
        }
        if !more {
            self.generation = self.generation.wrapping_add(1);
        }
        self.loading = true;
        self.error = None;
        self.request_failed = false;
        let gen_id = self.generation;
        let input = PullRequestListInput {
            state: PullRequestListState::All,
            involvement: None,
            filters: None,
            project_id: None,
            project_ids: None,
            host: None,
            limit: Some(50),
            cursors: more.then(|| self.next.clone()),
            query: None,
        };
        cx.spawn(async move |this, cx| {
            let result = conn
                .call::<list::Payload, list::Success>("pullRequests.list", &input)
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.generation != gen_id {
                    return;
                }
                panel.loading = false;
                match result {
                    Ok(page) => {
                        panel.loaded = true;
                        if !more {
                            panel.rows.clear();
                            panel.stats.clear();
                            panel.expanded = None;
                        }
                        let unknown = page
                            .entries
                            .iter()
                            .filter(|pr| pr.additions == 0 && pr.deletions == 0)
                            .map(reference)
                            .collect::<Vec<_>>();
                        panel.load_stats(unknown, cx);
                        let mut seen: HashSet<_> = panel.rows.iter().map(entry_key).collect();
                        panel.rows.extend(
                            page.entries
                                .into_iter()
                                .filter(|pr| seen.insert(entry_key(pr))),
                        );
                        panel.rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                        panel.next = page.next_cursors;
                        panel.truncated = page.truncated;
                        if !page.errors.is_empty() {
                            panel.error = Some(
                                page.errors
                                    .iter()
                                    .map(|e| format!("{}: {}", e.project_title, e.message))
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            );
                        }
                    }
                    Err(error) => {
                        panel.request_failed = true;
                        panel.error = Some(describe_rpc_error(&error).1);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// GitHub list queries omit diffstats by default. A zero pair in that response is unresolved.
    fn load_stats(&self, refs: Vec<PullRequestRef>, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        if refs.is_empty() {
            return;
        }
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            for chunk in refs.chunks(500) {
                let input = PullRequestListStatsInput {
                    refs: chunk.to_vec(),
                };
                let Ok(result) = conn
                    .call::<list_stats::Payload, list_stats::Success>(
                        "pullRequests.listStats",
                        &input,
                    )
                    .await
                else {
                    continue;
                };
                let current = this.update(cx, |panel, cx| {
                    if panel.generation != generation {
                        return false;
                    }
                    for stat in result.stats {
                        panel.stats.insert(
                            (stat.project_id, stat.repository, stat.number),
                            (stat.additions, stat.deletions),
                        );
                    }
                    cx.notify();
                    true
                });
                if !matches!(current, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }

    fn toggle_files(&mut self, pr: &PullRequestListEntry, cx: &mut Context<'_, Self>) {
        let key = entry_key(pr);
        if self.expanded.as_ref().is_some_and(|e| e.key == key) {
            self.expanded = None;
            cx.notify();
            return;
        }
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let reference = reference(pr);
        self.expanded = Some(ExpandedFiles {
            key: key.clone(),
            rows: None,
        });
        let gen_id = self.generation;
        cx.spawn(async move |this, cx| {
            let result = host_diff::load(&conn, &reference)
                .await
                .map(|rows| rows.into_iter().map(|row| row.entry).collect())
                .map_err(|error| describe_rpc_error(&error).1);
            let _ = this.update(cx, |panel, cx| {
                if panel.generation == gen_id
                    && let Some(expanded) = panel.expanded.as_mut()
                    && expanded.key == key
                {
                    expanded.rows = Some(result);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn row(&self, pr: &PullRequestListEntry, now: i64, cx: &mut Context<'_, Self>) -> AnyElement {
        let key = entry_key(pr);
        let hover = to_hsla(self.tokens.shell_highlight);
        let muted = to_hsla(self.tokens.muted_foreground);
        let status = Filter::status(pr);
        let status_color = to_hsla(match status {
            Filter::Merged => self.tokens.primary,
            Filter::Failing | Filter::Closed => self.tokens.destructive,
            Filter::Passing | Filter::Open => self.tokens.success,
            Filter::Running => self.tokens.warning,
            _ => self.tokens.muted_foreground,
        });
        let icon = div()
            .relative()
            .flex_shrink_0()
            .child(render_project_monogram(
                &pr.project_title,
                20.0,
                &self.tokens,
            ))
            .child(
                div()
                    .absolute()
                    .right(px(-1.0))
                    .bottom(px(-1.0))
                    .size(px(8.))
                    .rounded_full()
                    .bg(status_color)
                    .border_1()
                    .border_color(to_hsla(self.tokens.shell_card)),
            );
        let stats = |adds: usize, dels: usize| {
            h_flex()
                .gap(px(4.))
                .child(
                    div()
                        .text_color(to_hsla(self.tokens.diff_added))
                        .child(format!("+{adds}")),
                )
                .child(
                    div()
                        .text_color(to_hsla(self.tokens.diff_removed))
                        .child(format!("−{dels}")),
                )
        };
        let measured = if pr.additions != 0 || pr.deletions != 0 {
            Some((pr.additions, pr.deletions))
        } else {
            self.stats
                .get(&(pr.project_id.clone(), pr.repository.clone(), pr.number))
                .copied()
        };
        let stat_entry = pr.clone();
        let open_entry = pr.clone();
        let summary = [
            Some(format!("#{}", pr.number)),
            pr.author.as_ref().map(|a| a.login.clone()),
            pr.checks_state.map(|s| {
                match s {
                    PullRequestSummaryChecksState::Passing => "Checks passed",
                    PullRequestSummaryChecksState::Failing => "Checks failed",
                    PullRequestSummaryChecksState::Pending => "Checks running",
                }
                .to_owned()
            }),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let mut result = v_flex().child(
            v_flex()
                .id(SharedString::from(format!("pr-inbox-row-{key}")))
                .a11y_button(
                    format!("panel.pull-requests.open.{key}"),
                    format!("Open {}#{}: {}", pr.repository, pr.number, pr.title),
                )
                .tab_index(0)
                .p(px(12.))
                .gap(px(6.))
                .rounded(px(8.))
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(move |_, _, _, cx| cx.emit(OpenRequest(open_entry.clone()))))
                .child(
                    h_flex()
                        .items_center()
                        .gap(px(12.))
                        .child(icon)
                        .child(div().flex_1().min_w_0().truncate().child(pr.title.clone()))
                        .child(
                            div()
                                .id(SharedString::from(format!("pr-inbox-stat-{key}")))
                                .a11y_button(
                                    format!("panel.pull-requests.files.{key}"),
                                    format!("Change breakdown for #{}", pr.number),
                                )
                                .tab_index(0)
                                .rounded(px(4.))
                                .cursor_pointer()
                                .hover(move |s| s.bg(hover))
                                .on_click(cx.listener(move |panel, _, _, cx| {
                                    cx.stop_propagation();
                                    panel.toggle_files(&stat_entry, cx);
                                }))
                                .child(match measured {
                                    Some((adds, dels)) => {
                                        stats(adds as usize, dels as usize).into_any_element()
                                    }
                                    None => {
                                        div().text_color(muted).child("Changes").into_any_element()
                                    }
                                }),
                        ),
                )
                .child(
                    h_flex()
                        .pl(px(32.))
                        .gap(px(4.))
                        .text_size(px(13.))
                        .line_height(px(17.))
                        .text_color(muted)
                        .child(div().flex_1().min_w_0().truncate().child(summary))
                        .child(format_relative_time(&pr.updated_at, now)),
                ),
        );
        if let Some(expanded) = self.expanded.as_ref().filter(|e| e.key == key) {
            let mut body = v_flex()
                .ml(px(30.))
                .mr(px(8.))
                .px(px(8.))
                .py(px(5.))
                .gap(px(2.))
                .rounded(px(6.))
                .border_1()
                .border_color(to_hsla(self.tokens.shell_divider))
                .bg(to_hsla(self.tokens.shell_field))
                .text_size(px(11.));
            match &expanded.rows {
                None => body = body.child("Loading changed files…"),
                Some(Err(e)) => body = body.child(e.clone()),
                Some(Ok(rows)) if rows.is_empty() => body = body.child("No changed files"),
                Some(Ok(rows)) => {
                    for f in rows {
                        let (adds, dels) = f.line_counts(None);
                        body = body.child(
                            h_flex()
                                .id(SharedString::from(format!("pr-inbox-file-{}", f.path)))
                                .a11y_group(
                                    format!("panel.pull-requests.file.{}", f.path),
                                    f.path.clone(),
                                )
                                .gap(px(5.))
                                .items_center()
                                .child(superhero_icon("superhero/file.svg", 12., muted))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .font_family(crate::theme::MONO_FONT)
                                        .child(f.path.clone()),
                                )
                                .child(stats(adds, dels)),
                        );
                    }
                }
            }
            result = result.child(body);
        }
        result.into_any_element()
    }
}
/// What fills the whole inbox instead of the list.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum InboxNotice {
    /// No Conn server to ask.
    NoServer,
    /// The list call failed with this message.
    Failed(String),
    /// A list call finished and found nothing.
    NoPullRequests,
}

/// Which whole-panel state the inbox shows, if any: from what it holds and what it has loaded.
pub(super) fn inbox_notice(
    has_connection: bool,
    request_failed: bool,
    loaded: bool,
    loading: bool,
    has_rows: bool,
    error: Option<&str>,
) -> Option<InboxNotice> {
    if !has_connection {
        Some(InboxNotice::NoServer)
    } else if request_failed && !has_rows && !loading {
        Some(InboxNotice::Failed(error.unwrap_or_default().to_owned()))
    } else if loaded && !has_rows && error.is_none() && !loading {
        Some(InboxNotice::NoPullRequests)
    } else {
        None
    }
}

/// The empty state for a notice. A failure gets "Try again" when `retry` is given.
pub(super) fn notice_state(
    notice: &InboxNotice,
    retry: Option<Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>>,
) -> EmptyState {
    let (icon, title, description) = match notice {
        InboxNotice::NoServer => (
            "superhero/unplug.svg",
            "Pull requests unavailable",
            "Connect to a Conn server to browse pull requests.",
        ),
        InboxNotice::Failed(message) => {
            let (icon, title) = unavailable_notice(message);
            (icon, title, message.as_str())
        }
        InboxNotice::NoPullRequests => (
            "superhero/pull-request.svg",
            "No pull requests",
            "Pull requests from this workspace's repositories show here.",
        ),
    };
    let actions = retry
        .filter(|_| matches!(notice, InboxNotice::Failed(_)))
        .map(|on_click| EmptyAction {
            id: SharedString::from("pr-inbox-retry"),
            ax_id: SharedString::from("panel.pull-requests.retry"),
            label: SharedString::from("Try again"),
            icon: Some("superhero/refresh.svg"),
            on_click,
        })
        .into_iter()
        .collect();
    EmptyState {
        id: "pr-inbox-empty",
        ax_id: "panel.pull-requests.empty",
        label: "Pull requests",
        icon,
        title: SharedString::from(title.to_owned()),
        description: empty_state::plain(description),
        actions,
    }
}

impl PullRequestInbox {
    /// The inbox's whole-panel state, in the shared empty-state design. `None` when there is a
    /// list to show.
    fn render_empty(&self, window: &Window, cx: &mut Context<'_, Self>) -> Option<AnyElement> {
        let notice = inbox_notice(
            self.connection.is_some(),
            self.request_failed,
            self.loaded,
            self.loading,
            !self.rows.is_empty(),
            self.error.as_deref(),
        )?;
        let entity = cx.entity();
        let retry: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)> = Rc::new(move |_, cx| {
            entity.update(cx, |panel, cx| panel.load(false, cx));
        });
        Some(render_empty_state(
            window,
            &self.tokens,
            notice_state(&notice, Some(retry)),
        ))
    }
}
impl Render for PullRequestInbox {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if let Some(empty) = self.render_empty(window, cx) {
            return empty;
        }
        let tokens = &self.tokens;
        let muted = to_hsla(tokens.muted_foreground);
        let border = to_hsla(tokens.shell_divider_header);
        let field = || {
            h_flex()
                .items_center()
                .h(px(32.))
                .px(px(9.))
                .gap(px(6.))
                .rounded_full()
                .border_1()
                .border_color(border)
                .bg(to_hsla(tokens.shell_control))
        };
        let candidates = self
            .rows
            .iter()
            .filter(|r| matches_query(r, &self.query))
            .collect::<Vec<_>>();
        let label = |f: Filter| {
            format!(
                "{} ({})",
                f.label(),
                candidates.iter().filter(|r| f.matches(r)).count()
            )
        };
        let search = field()
            .id("pr-inbox-search")
            .a11y_group("panel.pull-requests.search", "Search pull requests")
            .flex_1()
            .min_w_0()
            .child(superhero_icon("superhero/search.svg", 14., muted))
            .child(
                Input::new(&self.search)
                    .appearance(false)
                    .text_size(px(13.)),
            )
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                if e.keystroke.key == "escape" {
                    this.search.update(cx, |s, cx| s.set_value("", window, cx));
                    cx.stop_propagation();
                }
            }))
            .test_support();
        let entity = cx.entity();
        let filter = super::filters::control(
            tokens,
            "panel.pull-requests.filter",
            "Filter pull requests",
            self.filter,
            Filter::ALL.into_iter().map(|f| (f, label(f))).collect(),
            move |selected, cx| {
                entity.update(cx, |panel, cx| {
                    panel.filter = selected;
                    cx.notify();
                })
            },
        );
        let mut rows = v_flex()
            .id("pr-inbox-rows")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .gap(px(4.))
            .p(px(8.));
        let now = now_epoch_ms();
        let mut count = 0;
        for pr in candidates.into_iter().filter(|pr| self.filter.matches(pr)) {
            rows = rows.child(self.row(pr, now, cx));
            count += 1;
        }
        if let Some(error) = &self.error {
            rows = rows.child(div().p(px(12.)).text_color(muted).child(error.clone()));
        } else if self.loading {
            rows = rows.child("Loading pull requests…");
        } else if count == 0 {
            rows = rows.child(
                v_flex()
                    .items_center()
                    .py(px(30.))
                    .child("No matching pull requests")
                    .when(self.filter != Filter::All || !self.query.is_empty(), |e| {
                        e.child(
                            div()
                                .id("pr-inbox-clear")
                                .a11y_button("panel.pull-requests.clear", "Clear filters")
                                .tab_index(0)
                                .cursor_pointer()
                                .text_color(muted)
                                .child("Clear filters")
                                .on_click(cx.listener(|p, _, window, cx| {
                                    p.filter = Filter::All;
                                    p.search.update(cx, |s, cx| s.set_value("", window, cx));
                                    cx.notify()
                                })),
                        )
                    }),
            );
        }
        let more = !self.next.is_empty();
        if !self.loading && (more || self.error.is_some()) {
            let label = if more { "Load more" } else { "Retry" };
            rows = rows.child(
                div()
                    .id("pr-inbox-load")
                    .a11y_button("panel.pull-requests.load", label)
                    .tab_index(0)
                    .cursor_pointer()
                    .p(px(8.))
                    .child(label)
                    .on_click(cx.listener(move |p, _, _, cx| p.load(more, cx))),
            );
        }
        let suffix = if self.truncated || more {
            " loaded"
        } else {
            ""
        };
        v_flex()
            .size_full()
            .id("pr-inbox")
            .a11y_group("panel.pull-requests", "Pull requests")
            .text_size(px(14.))
            .line_height(px(20.))
            .text_color(to_hsla(tokens.foreground))
            .child(
                h_flex()
                    .items_center()
                    .gap(px(8.))
                    .p(px(8.))
                    .border_b_1()
                    .border_color(border)
                    .child(search)
                    .child(filter),
            )
            .child(rows)
            .child(
                div()
                    .border_t_1()
                    .border_color(border)
                    .px(px(12.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .text_color(muted)
                    .child(format!(
                        "{count} of {}{suffix} pull requests",
                        self.rows.len()
                    )),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "only fixture decoding returns an error"
    )]
    fn open_includes_drafts_and_summary_checks_apply_to_open_prs() -> Result<(), serde_json::Error>
    {
        let mut pr: PullRequestListEntry = serde_json::from_value(serde_json::json!({
            "provider":"github","host":"github.com","projectId":"project","projectTitle":"First project","repository":"owner/repo",
            "number":14,"title":"Map workspace","url":"https://github.com/owner/repo/pull/14",
            "author":{"login":"alex","name":null,"avatarUrl":null},"headBranch":"feat/map","baseBranch":"main",
            "state":"open","isDraft":true,"mergeability":"unknown","additions":2,"deletions":3,
            "createdAt":"2026-10-01","updatedAt":"2026-10-02","viewerReviewRequested":false,"labels":[],
            "checksState":"pending"
        }))?;
        assert!(
            Filter::Open.matches(&pr) && Filter::Draft.matches(&pr),
            "open includes drafts"
        );
        pr.is_draft = false;
        assert!(Filter::Running.matches(&pr), "open and pending");
        pr.state = PullRequestState::Merged;
        assert!(
            !Filter::Running.matches(&pr),
            "a merged PR retains its terminal state"
        );
        for query in ["owner/repo#14", "alex", "feat/map", "first project"] {
            assert!(matches_query(&pr, query), "missing result for {query}");
        }
        Ok(())
    }
}
