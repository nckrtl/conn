import { copyFeedText } from "./copyFeedText";
import { FileAttachmentRow } from "./GalleryCard";
import { useId, useState } from "react";
import { Icon, ProviderIcon } from "./Icon";
import { WithStatusDot } from "./StatusDot";
import { MarkdownText, markdownPreviewText } from "./Markdown";
import type { LabEntry, TaskCardData } from "../data/fixtures";
import "./FeedCards.css";

export function UserBubble({
  entry,
  time,
}: {
  entry: Extract<LabEntry, { kind: "user" }>;
  time: string;
}) {
  const { text, images, attachments } = entry;
  const hasImages = !!images?.length;
  return (
    <div className="m-user">
      <div className="m-user-bubble" data-images={hasImages || undefined}>
        {text && <span>{text}</span>}
        {!!attachments?.length && (
          <div className="m-gallery-file-list">
            {attachments.map((file) => (
              <FileAttachmentRow key={file.id} {...file} />
            ))}
          </div>
        )}
        {hasImages && (
          <div
            className="m-user-gallery"
            style={{ gridTemplateColumns: `repeat(${Math.min(images.length, 4)}, minmax(0, 1fr))` }}
          >
            {images.map((image) => (
              <img key={image.src} src={image.src} alt={image.alt} />
            ))}
          </div>
        )}
      </div>
      <div className="m-user-meta">
        <span>{time}</span>
        <button aria-label="Copy message" onClick={() => void copyFeedText(text)}>
          <Icon name="copy" size={12} />
        </button>
      </div>
    </div>
  );
}

export function WorkingDivider({ label, steps }: { label: string; steps: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="m-working">
      <button
        className="m-working-label"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {label} <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
      </button>
      {expanded && (
        <ul>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// chat/mod.rs render_agent_prompt_row
export function AgentPromptRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview =
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "Prompt";
  return (
    <div className="m-agent-prompt">
      <button
        className="m-agent-row"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <strong>Agent</strong>
        <span>{preview}</span>
      </button>
      {expanded && <div className="m-agent-detail">{text}</div>}
    </div>
  );
}

export function AgentMessageCard({
  entry,
}: {
  entry: Extract<LabEntry, { kind: "agentMessage" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const senderTitle = entry.from && entry.from !== "Agent" ? entry.from : "Message";
  return (
    <section className="m-agent-message m-disclosure-card" aria-label="Agent message">
      <div className="m-feed-card-header m-agent-message-label">
        <span className="m-card-icon">
          <Icon name="agent" size={16} />
        </span>
        Agent
      </div>
      <CardDisclosure
        label="agent message"
        contentId={contentId}
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      />
      <div className="m-feed-card-content">
        <div className="m-feed-card-title">
          {senderTitle}
          <CardChevron expanded={expanded} />
        </div>
        <CardMessage id={contentId} markdown={entry.text} expanded={expanded} />
      </div>
    </section>
  );
}

function CardMessage({
  id,
  markdown,
  expanded,
}: {
  id: string;
  markdown: string;
  expanded: boolean;
}) {
  return (
    <div id={id} className="m-feed-card-summary">
      {expanded ? (
        <MarkdownText markdown={markdown} />
      ) : (
        <div className="m-feed-card-preview">
          {markdownPreviewText(markdown).replace(/\s+/g, " ").trim()}
        </div>
      )}
    </div>
  );
}

function CardDisclosure({
  label,
  contentId,
  expanded,
  onClick,
}: {
  label: string;
  contentId: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="m-card-disclosure"
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      aria-controls={contentId}
      aria-expanded={expanded}
      onClick={onClick}
    />
  );
}

function CardChevron({ expanded }: { expanded: boolean }) {
  return (
    <span className="m-card-disclosure-chevron" aria-hidden="true">
      <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} />
    </span>
  );
}

// chat/cards.rs render_subagent_row and render_subagent_summary
export function SubagentCard({ entry }: { entry: Extract<LabEntry, { kind: "subagent" }> }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { title, status, instanceId, model, effort, elapsed, summary } = entry;
  const state = status === "running" ? "working" : status === "completed" ? "done" : "failed";
  return (
    <section
      className={summary ? "m-subagent m-disclosure-card" : "m-subagent"}
      data-status={status}
      aria-label={`Subagent ${title}, ${status}`}
    >
      <div className="m-feed-card-header">
        <WithStatusDot state={state} ring="var(--thread-card-surface)">
          <span className="m-card-icon m-card-provider-icon">
            <ProviderIcon provider={instanceId} size={16} />
          </span>
        </WithStatusDot>
        <div className="m-subagent-meta">
          <span>{[model, effort, !elapsed && status].filter(Boolean).join(" · ")}</span>
          {elapsed && <span className="m-card-duration">{elapsed}</span>}
        </div>
      </div>
      {summary && (
        <CardDisclosure
          label={`subagent summary for ${title}`}
          contentId={contentId}
          expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        />
      )}
      <div className="m-feed-card-content">
        <div className="m-feed-card-title">
          {title}
          {summary && <CardChevron expanded={expanded} />}
        </div>
        {summary && <CardMessage id={contentId} markdown={summary} expanded={expanded} />}
      </div>
    </section>
  );
}

// The inline TaskRow uses a checklist glyph and the same boxed face as a subagent.
export function OrbitTaskCard({ task, onOpen }: { task: TaskCardData; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="m-orbit-receipt"
      aria-label={`Orbit task #${task.id}, ${task.title}, ${task.dot}`}
    >
      <div className="m-feed-card-header">
        <WithStatusDot state={task.dot} ring="var(--thread-card-surface)">
          <span className="m-card-icon m-card-task-icon" aria-hidden="true" />
        </WithStatusDot>
        <div className="m-receipt-meta">
          <span>
            {task.project.toLowerCase()} · #{task.id} · {task.subtasks}
          </span>
          <span className="m-card-duration">{task.time}</span>
          <span>· {task.node}</span>
          {task.pr && (
            <>
              <span aria-hidden>·</span>
              <span className="m-task-pr" data-state={task.pr.state}>
                <Icon name={task.pr.state === "merged" ? "merge" : "pull-request"} size={14} />#
                {task.pr.number}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="m-feed-card-content">
        <div className="m-feed-card-title">{task.title}</div>
      </div>
    </button>
  );
}
