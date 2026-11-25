import type { TaskDetailData } from "../data/taskDetails";
import { Icon, ProviderIcon, StatusRing } from "./Icon";
import { WithStatusDot } from "./StatusDot";
import "./RecordDetail.css";

const tokenFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const agentDotStates = {
  Working: "working",
  Idle: "waiting",
  Done: "done",
  Failed: "failed",
} as const;

export function SubtasksList({ subtasks }: { subtasks: TaskDetailData["subtasks"] }) {
  return subtasks.length ? (
    subtasks.map((sub) => (
      <details className="ios-detail-row ios-subtask" key={sub.title}>
        <summary>
          <span className="ios-subtask-indicator" data-status={sub.status}>
            {sub.status === "Completed" || sub.status === "Failed" ? (
              <Icon name={sub.status === "Completed" ? "check-circle" : "error-circle"} size={17} />
            ) : (
              <StatusRing spinning={sub.status === "In progress"} />
            )}
          </span>
          <strong>{sub.title}</strong>
          {sub.status === "Completed" && sub.lines && (
            <span className="ios-detail-diff">
              <span>+{sub.lines.added}</span>
              <span>−{sub.lines.removed}</span>
            </span>
          )}
          <small>
            {sub.status}
            {sub.tokens !== undefined && ` · ${tokenFormat.format(sub.tokens)} tokens`}
            {sub.minutes !== undefined && ` · ${sub.minutes}m`}
          </small>
        </summary>
        <div className="ios-detail-expanded">
          <p>{sub.brief}</p>
          {sub.deliverables && (
            <>
              <strong>Deliverables</strong>
              <ul>
                {sub.deliverables.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>
    ))
  ) : (
    <p className="ios-detail-muted">No subtasks yet.</p>
  );
}

export function AgentsList({ agents }: { agents: TaskDetailData["agents"] }) {
  return agents.length ? (
    agents.map((agent) => (
      <div className="ios-detail-row ios-agent-row" key={agent.assignment}>
        <span className="ios-agent-icon">
          <WithStatusDot
            state={agentDotStates[agent.state]}
            label={agent.state}
            ring="var(--color-screen)"
          >
            <ProviderIcon provider={agent.provider} size={14} />
          </WithStatusDot>
        </span>
        <span>
          <strong>{agent.assignment}</strong>
          <small>
            {agent.role} · {agent.model}
          </small>
        </span>
      </div>
    ))
  ) : (
    <p className="ios-detail-muted">No agents assigned.</p>
  );
}
