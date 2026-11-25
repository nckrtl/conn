import { useLayoutEffect, useRef, useState } from "react";
import { copyFeedText } from "../../../lab-ios/src/components/copyFeedText";
import { FEED_THREAD, LAB_ENVIRONMENT_LABEL } from "../../../lab-ios/src/data/fixtures";
import { requests } from "./desktopPullRequests";
import { prKey } from "../../../lab-ios/src/data/pullRequests";
import { defaultThread, tasks, type Thread } from "./fixtures";
import { Icon } from "./Icon";
import "./ThreadDetails.css";

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
