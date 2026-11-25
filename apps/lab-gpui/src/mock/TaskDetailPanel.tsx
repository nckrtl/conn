import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { TASKS, type TaskCardData } from "../../../lab-ios/src/data/fixtures";
import { requests } from "./desktopPullRequests";
import { taskDetails, type TaskDetailData } from "../../../lab-ios/src/data/taskDetails";
import { tasks as desktopTasks } from "./fixtures";
import { AgentsList, SubtasksList } from "../../../lab-ios/src/components/TaskDetailRows";
import "./DetailTabs.css";
import "./TaskDetailPanel.css";

/** Section strings the panel reads from `section` and reports through `onNavigate`. */
export const TASK_DETAIL_SECTIONS = ["brief", "subtasks", "agents"] as const;
export type TaskDetailSection = (typeof TASK_DETAIL_SECTIONS)[number];

const sectionLabels: Record<TaskDetailSection, string> = {
  brief: "Brief",
  subtasks: "Subtasks",
  agents: "Agents",
};

function parseSection(section: string | undefined): TaskDetailSection {
  const value = section?.trim().toLowerCase();
  return TASK_DETAIL_SECTIONS.find((candidate) => candidate === value) ?? "brief";
}

const glyphPath = "../../../conn-gpui/crates/conn-app/assets/icons/superhero/16/solid/";
const glyphs = import.meta.glob<string>(
  "../../../conn-gpui/crates/conn-app/assets/icons/superhero/16/solid/{chevron-left,chevron-right,chevron-down,server,branch,pull-request,pull-request-closed,merge,usage,file-diff,check,circle,circle-dashed,close,question,agent,unplug}.svg",
  { eager: true, import: "default", query: "?url" },
);

function Glyph({ name, tone, size = 14 }: { name: string; tone?: Tone; size?: number }) {
  const src = glyphs[`${glyphPath}${name}.svg`];
  return (
    <span
      aria-hidden="true"
      className="td-glyph"
      data-name={name}
      data-tone={tone}
      style={{ "--glyph": `url("${src}")`, "--size": `${size}px` } as CSSProperties}
    />
  );
}

type Tone = "success" | "info" | "warning" | "destructive" | "muted" | "merged" | "closed";

// Task 470 exists only in the desktop fixture, so its detail lives here.
const desktopOnlyDetails: Readonly<Record<number, TaskDetailData>> = {
  470: {
    status: "In review",
    workspace: "conn-thread-search",
    branch: "orbit/470-thread-search",
    usage: "47m · 1.2M tokens",
    brief:
      "Search connected environments and open a matching thread.\n\n## Outcome\nOne search box finds threads in every connected environment. Picking a result opens the thread in its own environment.\n\n## Constraints\n- Keep results responsive while an environment is slow or offline.\n- Show which environment each match comes from.",
    subtasks: [
      {
        title: "Search index per environment",
        status: "Completed",
        brief: "Index thread titles and messages in each environment.",
        deliverables: ["Per-environment index", "Offline environment handling"],
        tokens: 420_000,
        minutes: 19,
        lines: { added: 212, removed: 31 },
      },
      {
        title: "Merge results in the sidebar",
        status: "Completed",
        brief: "Merge matches from every environment into one ranked list.",
        tokens: 510_000,
        minutes: 17,
        lines: { added: 148, removed: 22 },
      },
      {
        title: "Jump to a match",
        status: "In progress",
        brief: "Open the matching thread and scroll to the matching message.",
        tokens: 270_000,
        minutes: 11,
      },
    ],
    agents: [
      {
        role: "Implementer",
        provider: "codex",
        model: "GPT-5.5 Codex",
        state: "Working",
        assignment: "Jump to a match",
      },
      {
        role: "Reviewer",
        provider: "claudeAgent",
        model: "Claude Opus 5.5",
        state: "Idle",
        assignment: "Review the pull request",
      },
    ],
  },
};

interface ResolvedTask {
  id: number;
  title: string;
  node?: string | undefined;
  pr?: { id: string; number: number; state: "open" | "merged" | "closed" } | undefined;
  added?: number | undefined;
  removed?: number | undefined;
  detail: TaskDetailData;
}

const emptyDetail: TaskDetailData = { brief: "", status: "", subtasks: [], agents: [] };

function pullRequestLink(number: number, state: "open" | "merged" | "closed") {
  const record = requests.find((pr) => pr.number === number);
  if (!record) return undefined;
  return {
    id: `${record.repo}#${number}`,
    number,
    state: record?.state === "Merged" ? ("merged" as const) : state,
    added: record?.added,
    removed: record?.removed,
  };
}

function resolveTask(id: number): ResolvedTask | null {
  const card: TaskCardData | undefined = TASKS.find((task) => task.id === id);
  if (card) {
    const link = card.pr ? pullRequestLink(card.pr.number, card.pr.state) : undefined;
    return {
      id,
      title: card.title,
      node: card.node,
      pr: link,
      added: link?.added,
      removed: link?.removed,
      detail: taskDetails[id] ?? desktopOnlyDetails[id] ?? emptyDetail,
    };
  }
  const desktop = desktopTasks.find((task) => task.id === id);
  if (desktop) {
    const link = pullRequestLink(desktop.pr, "open");
    return {
      id,
      title: desktop.title,
      node: "beast",
      pr: link,
      added: link?.added,
      removed: link?.removed,
      detail: desktopOnlyDetails[id] ?? {
        ...emptyDetail,
        status: desktop.status,
        brief: desktop.brief,
        subtasks: desktop.subtasks.map((title) => ({
          title,
          status: "To do",
          brief: "",
        })),
      },
    };
  }
  return null;
}

const DASH = "–";

const prIcons = {
  open: { name: "pull-request", label: "Open" },
  merged: { name: "merge", label: "Merged" },
  closed: { name: "pull-request-closed", label: "Closed" },
} as const;

function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="td-diff">
      <span data-kind="added">+{added.toLocaleString("en-US")}</span>
      <span data-kind="removed">−{removed.toLocaleString("en-US")}</span>
    </span>
  );
}

function Inline({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      nodes.push(<code key={offset}>{part.slice(1, -1)}</code>);
    else if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      nodes.push(<strong key={offset}>{part.slice(2, -2)}</strong>);
    else nodes.push(<Fragment key={offset}>{part}</Fragment>);
    offset += part.length;
  }
  return <>{nodes}</>;
}

/** Headings, paragraphs and bullet lists: all a task brief uses. Headings stay at body size. */
function Brief({ source }: { source: string }) {
  if (!source.trim()) return <p className="td-empty">No brief.</p>;
  const blocks: ReactNode[] = [];
  let list: { line: number; text: string }[] = [];
  const flush = () => {
    const [first] = list;
    if (!first) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={first.line}>
        {items.map((item) => (
          <li key={item.line}>
            <Inline text={item.text} />
          </li>
        ))}
      </ul>,
    );
  };
  for (const [lineNumber, raw] of source.split("\n").entries()) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push({ line: lineNumber, text: bullet[1]! });
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <h3 key={lineNumber}>
          <Inline text={heading[1]!} />
        </h3>
      ) : (
        <p key={lineNumber}>
          <Inline text={line} />
        </p>
      ),
    );
  }
  flush();
  return <div className="td-brief">{blocks}</div>;
}

function MetaRow({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div className="td-meta-row">
      <dt>
        <Glyph name={icon} />
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

interface PanelProps {
  id: number;
  onBack: () => void;
  onOpenPr: (id: string) => void;
  section?: string | undefined;
  onNavigate?: ((section: string) => void) | undefined;
}

function Nav({ taskId, onBack }: { taskId?: number; onBack: () => void }) {
  return (
    <nav className="td-nav" aria-label="Task breadcrumbs">
      <button type="button" className="td-back" onClick={onBack}>
        <Glyph name="chevron-left" size={16} />
        Tasks
      </button>
      {taskId !== undefined && (
        <>
          <span className="td-sep" aria-hidden="true">
            /
          </span>
          <span aria-current="page">#{taskId}</span>
        </>
      )}
    </nav>
  );
}

function Unavailable({ id, onBack }: Pick<PanelProps, "id" | "onBack">) {
  return (
    <section className="td" aria-label={`Task #${id}`} data-state="unavailable">
      <Nav onBack={onBack} />
      <div className="td-unavailable" role="status">
        <Glyph name="unplug" size={20} />
        <div>
          <strong>Task unavailable</strong>
          <p>Task #{id} is not available in this environment.</p>
        </div>
        <button type="button" className="td-button" onClick={onBack}>
          Back to tasks
        </button>
      </div>
    </section>
  );
}

function TaskDetailBody({
  task,
  onBack,
  onOpenPr,
  section,
  onNavigate,
}: Omit<PanelProps, "id"> & { task: ResolvedTask }) {
  const [localSection, setLocalSection] = useState<TaskDetailSection>("brief");
  const active = section === undefined ? localSection : parseSection(section);
  const { detail } = task;
  const done = detail.subtasks.filter((subtask) => subtask.status === "Completed").length;
  const select = (next: TaskDetailSection) => {
    setLocalSection(next);
    onNavigate?.(next);
  };
  const counts: Record<TaskDetailSection, string | undefined> = {
    brief: undefined,
    subtasks: `${done}/${detail.subtasks.length}`,
    agents: String(detail.agents.length),
  };
  const pr = task.pr;
  const prIcon = pr ? prIcons[pr.state] : undefined;

  return (
    <section
      className="td"
      aria-label={`Task #${task.id}`}
      data-state="ready"
      data-section={active}
    >
      <Nav taskId={task.id} onBack={onBack} />
      <div className="td-body">
        <h2 className="td-title">{task.title}</h2>
        <div className="td-scroll">
          <dl className="td-meta">
            <MetaRow icon="circle" label="Status">
              {detail.status}
            </MetaRow>
            <MetaRow icon="server" label="Workspace">
              {detail.workspace ? (
                <>
                  <span className="td-truncate">{detail.workspace}</span>
                  {task.node && <span className="td-quiet">on {task.node}</span>}
                </>
              ) : (
                <span className="td-quiet">No workspace yet</span>
              )}
            </MetaRow>
            {detail.branch && (
              <MetaRow icon="branch" label="Branch">
                <span className="td-truncate td-quiet">{detail.branch}</span>
              </MetaRow>
            )}
            {pr && prIcon && (
              <MetaRow icon="pull-request" label="Pull request">
                <button
                  type="button"
                  className="td-pr-link"
                  aria-label={`Open linked pull request ${pr.id}`}
                  onClick={() => onOpenPr(pr.id)}
                >
                  <Glyph name={prIcon.name} tone={pr.state === "open" ? "success" : pr.state} />
                  <span>{prIcon.label}</span>
                  <span className="td-quiet">#{pr.number}</span>
                </button>
              </MetaRow>
            )}
            <MetaRow icon="usage" label="Usage">
              <span className="td-truncate">{detail.usage ?? DASH}</span>
            </MetaRow>
            <MetaRow icon="file-diff" label="Changes">
              {task.added === undefined || task.removed === undefined ? (
                <span className="td-quiet">Not reported yet</span>
              ) : (
                <DiffStat added={task.added} removed={task.removed} />
              )}
            </MetaRow>
          </dl>
          <div className="detail-tabs" role="tablist" aria-label="Task detail sections">
            {TASK_DETAIL_SECTIONS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`td-tab-${name}`}
                aria-selected={active === name}
                aria-controls="td-tabpanel"
                onClick={() => select(name)}
              >
                {sectionLabels[name]}
                {counts[name] && <span className="detail-tab-count">{counts[name]}</span>}
              </button>
            ))}
          </div>
          <div
            className="td-tabpanel"
            id="td-tabpanel"
            role="tabpanel"
            aria-labelledby={`td-tab-${active}`}
          >
            {active === "brief" && <Brief source={detail.brief} />}
            {active === "subtasks" && <SubtasksList subtasks={detail.subtasks} />}
            {active === "agents" && <AgentsList agents={detail.agents} />}
          </div>
        </div>
      </div>
    </section>
  );
}

export function TaskDetailPanel({ id, onBack, onOpenPr, section, onNavigate }: PanelProps) {
  const task = resolveTask(id);
  if (!task) return <Unavailable id={id} onBack={onBack} />;
  return (
    <TaskDetailBody
      key={id}
      task={task}
      onBack={onBack}
      onOpenPr={onOpenPr}
      section={section}
      onNavigate={onNavigate}
    />
  );
}
