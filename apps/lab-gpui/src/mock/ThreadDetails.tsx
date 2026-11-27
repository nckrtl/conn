import { useLayoutEffect, useRef, useState } from "react";
import { copyFeedText } from "../../../lab-ios/src/components/copyFeedText";
import { FEED_THREAD, LAB_ENVIRONMENT_LABEL } from "../../../lab-ios/src/data/fixtures";
import { requests } from "./desktopPullRequests";
import { prKey } from "../../../lab-ios/src/data/pullRequests";
import { backgroundThread, defaultThread, tasks, type Thread } from "./fixtures";
import { Icon } from "./Icon";
import "./ThreadDetails.css";

// GPUI `header/details_card.rs` sections the lab shows on the background commands thread, with the
// texts of GPUI's `details_schedules` and `details_wakeups` screenshots.
type DotState = "running" | "done" | "failed" | "idle";
interface Automation {
  title: string;
  line: string;
  dot: DotState;
  enabled: boolean;
}
interface ChildAgent {
  title: string;
  provider: "claude" | "openai";
  meta: string;
  state: DotState;
  trailing: string;
}
const automations: Automation[] = [
  { title: "Morning digest", line: "Daily at 09:00 · next in 3h", dot: "done", enabled: true },
  { title: "Weekly cleanup", line: "Every 60 min · paused", dot: "failed", enabled: false },
];
const wakeups = [
  { title: "Check the CI run", line: "Wakeup · one-off · next in 4m (est.)" },
  { title: "Check the deploy", line: "Cron · recurring · Every 5 minutes" },
];
const runningAgents: ChildAgent[] = [
  {
    title: "Set up executor v2 + Orbit MCP for conn machine",
    provider: "claude",
    meta: "on nick · Opus 5.5 · medium",
    state: "running",
    trailing: "2m",
  },
];
const previousAgents: ChildAgent[] = [
  {
    title: "Check stalled pull requests",
    provider: "openai",
    meta: "GPT-6.2 Astra · high",
    state: "done",
    trailing: "48s",
  },
  {
    title: "Rebuild the icon set",
    provider: "claude",
    meta: "Opus 5.5 · medium",
    state: "failed",
    trailing: "Failed",
  },
];

/** A glyph with the 6px status dot in a 2px popover-coloured ring on its top right. */
function WithDot({ icon, state }: { icon: string; state: DotState }) {
  return (
    <span className="inspector-dot-host">
      <Icon name={icon} />
      <i className="inspector-dot" data-state={state} />
    </span>
  );
}

function AgentRow({ agent }: { agent: ChildAgent }) {
  return (
    <button className="inspector-row inspector-agent" data-tip={agent.title}>
      <WithDot icon={agent.provider} state={agent.state} />
      <span className="inspector-two-line">
        <span>{agent.title}</span>
        <small>{agent.meta}</small>
      </span>
      <small>{agent.trailing}</small>
    </button>
  );
}

interface ThreadDetailsProps {
  thread: Thread;
  onClose: () => void;
  onOpenPr: (id: string) => void;
  onOpenTask: (id: number) => void;
  onOpenFiles: () => void;
}

export function ThreadDetails({
  thread,
  onClose,
  onOpenPr,
  onOpenTask,
  onOpenFiles,
}: ThreadDetailsProps) {
  const card = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const entries = thread.id === FEED_THREAD.key ? FEED_THREAD.entries : [];
  const linkedTasks =
    thread.id === defaultThread.id
      ? tasks.map((task) => ({ id: task.id, title: task.title, project: "Conn", pr: task.pr }))
      : entries.flatMap((entry) =>
          entry.kind === "orbitTask"
            ? [
                {
                  id: entry.task.id,
                  title: entry.task.title,
                  project: entry.task.project,
                  pr: entry.task.pr?.number,
                },
              ]
            : [],
        );
  const linkedPrs = requests.filter((pr) =>
    linkedTasks.some((task) => task.pr === pr.number && task.project === pr.project),
  );
  const agents = entries.filter((entry) => entry.kind === "subagent");
  const scheduled = thread.id === backgroundThread.id;
  const [enabled, setEnabled] = useState(() => automations.map((task) => task.enabled));
  const [previousOpen, setPreviousOpen] = useState(false);
  const running = agents.filter((agent) => agent.status === "running");
  const previous = agents.filter((agent) => agent.status !== "running");
  const environment =
    thread.id === FEED_THREAD.key
      ? LAB_ENVIRONMENT_LABEL
      : thread.id === "delegation-smoke"
        ? "mini"
        : "nick";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Move keyboard focus into the mounted popover so Escape works from a direct link.
  useLayoutEffect(() => {
    card.current?.focus();
  }, []);

  async function copy(value: string, name: string) {
    setCopyStatus(
      (await copyFeedText(value)) ? name + " copied" : "Could not copy " + name.toLowerCase(),
    );
  }

  return (
    <>
      <div className="details-dismiss" aria-hidden="true" onClick={onClose} />
      <div
        className="thread-inspector"
        ref={card}
        role="dialog"
        aria-label="Thread details"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            const toggle = card.current
              ?.closest(".conversation")
              ?.querySelector<HTMLButtonElement>('button[aria-label="Toggle thread details"]');
            onClose();
            toggle?.focus();
          }
        }}
      >
        <section aria-label="Workspace">
          <div className="inspector-row">
            <Icon name="desktop" />
            <span>{environment}</span>
            <span className="inspector-project">
              <Icon name="folder" />
              {thread.project}
            </span>
          </div>
          {thread.project !== "No project" && (
            <button className="inspector-row" onClick={onOpenFiles}>
              <Icon name="files" />
              Open in Files
            </button>
          )}
        </section>
        {(thread.branch || linkedPrs.length > 0) && (
          <section aria-label="Version control">
            {thread.branch && (
              <button
                className="inspector-row"
                data-tip="Copy branch name"
                aria-label={"Copy branch name: " + thread.branch}
                onClick={() => void copy(thread.branch, "Branch name")}
              >
                <Icon name="branch" />
                <span>{thread.branch}</span>
                <i className="inspector-copy">
                  <Icon name="copy" />
                </i>
              </button>
            )}
            {linkedPrs.map((pr) => (
              <button
                className="inspector-row"
                key={prKey(pr)}
                data-tip={pr.title}
                onClick={() => onOpenPr(prKey(pr))}
              >
                <Icon name="pull-request" />
                <span>
                  {pr.repo}#{pr.number}
                </span>
              </button>
            ))}
            {copyStatus && <small role="status">{copyStatus}</small>}
          </section>
        )}
        {linkedTasks.length > 0 && (
          <section aria-label="Linked tasks">
            <h3>Tasks</h3>
            {linkedTasks.map((task) => (
              <button
                className="inspector-row"
                key={task.id}
                data-tip={task.title}
                onClick={() => onOpenTask(task.id)}
              >
                <Icon name="checklist" />
                <span>
                  #{task.id} · {task.title}
                </span>
              </button>
            ))}
          </section>
        )}
        {scheduled && (
          <section aria-label="Automations">
            <h3>
              Automations
              <button
                className="inspector-icon-button"
                aria-label="Manage scheduled tasks"
                data-tip="Manage scheduled tasks"
              >
                <Icon name="adjust" />
              </button>
            </h3>
            {automations.map((task, index) => (
              <div
                className="inspector-row inspector-task"
                key={task.title}
                data-tip={task.title + "\n" + task.line}
              >
                <WithDot icon="scheduled" state={task.dot} />
                <span className="inspector-two-line inspector-task-text">
                  <span>{task.title}</span>
                  <small>{task.line}</small>
                </span>
                <button
                  className="inspector-icon-button"
                  aria-label={"Run " + task.title + " now"}
                  data-tip="Run now"
                >
                  <Icon name="play" />
                </button>
                <button
                  className="inspector-switch"
                  role="switch"
                  aria-checked={enabled[index]}
                  aria-label={(enabled[index] ? "Pause " : "Resume ") + task.title}
                  onClick={() => setEnabled(enabled.map((on, i) => (i === index ? !on : on)))}
                />
              </div>
            ))}
          </section>
        )}
        {scheduled && (
          <section aria-label="Agent wakeups">
            <h3>Agent wakeups</h3>
            {wakeups.map((wakeup) => (
              <div
                className="inspector-row inspector-task"
                key={wakeup.title}
                data-tip={wakeup.title + "\n" + wakeup.line + "\nConn cannot cancel this wakeup."}
              >
                <Icon name="scheduled" />
                <span className="inspector-two-line inspector-task-text">
                  <span>{wakeup.title}</span>
                  <small>{wakeup.line}</small>
                </span>
              </div>
            ))}
          </section>
        )}
        {scheduled && (
          <section aria-label="Subagents">
            <h3>Subagents · {runningAgents.length} running</h3>
            {runningAgents.map((agent) => (
              <AgentRow key={agent.title} agent={agent} />
            ))}
            <button
              className="inspector-row"
              aria-expanded={previousOpen}
              onClick={() => setPreviousOpen(!previousOpen)}
            >
              <Icon name="agent" />
              <span>Previous agents</span>
              <small className="inspector-failed">1 failed</small>
              {!previousOpen && <small className="inspector-count">{previousAgents.length}</small>}
              <Icon name={previousOpen ? "chevron-down" : "chevron-right"} />
            </button>
            {previousOpen &&
              previousAgents.map((agent) => <AgentRow key={agent.title} agent={agent} />)}
          </section>
        )}
        {agents.length > 0 && (
          <section aria-label="Subagents">
            <h3>Subagents · {running.length} running</h3>
            {running.map((agent) => (
              <div className="inspector-row" key={agent.title} data-tip={agent.title}>
                <Icon name="agent" />
                <span>{agent.title}</span>
                <small>{agent.elapsed}</small>
              </div>
            ))}
            {previous.length > 0 && (
              <details>
                <summary className="inspector-row">
                  <Icon name="chevron-right" />
                  <span>Previous agents</span>
                  <small>{previous.length}</small>
                </summary>
                {previous.map((agent) => (
                  <div className="inspector-row" key={agent.title} data-tip={agent.title}>
                    <Icon name="check" />
                    <span>{agent.title}</span>
                    <small>{agent.elapsed}</small>
                  </div>
                ))}
              </details>
            )}
          </section>
        )}
      </div>
    </>
  );
}
