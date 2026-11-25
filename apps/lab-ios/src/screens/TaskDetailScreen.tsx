import { DetailField, RecordDetail } from "../components/RecordDetail";
import { Icon } from "../components/Icon";
import { AgentsList, SubtasksList } from "../components/TaskDetailRows";
import { MarkdownText } from "../components/Markdown";
import { type TaskCardData } from "../data/fixtures";
import { taskDetails } from "../data/taskDetails";
import { requests, type LabPullRequest } from "../data/pullRequests";
import { SCREENS } from "../urlState";

export default function TaskDetailScreen({
  task,
  offline,
  tab,
  onTab,
  onBack,
  openPr,
}: {
  task: TaskCardData;
  offline: boolean;
  tab: string;
  onTab: (t: string) => void;
  onBack: () => void;
  openPr: (pr: LabPullRequest) => void;
}) {
  const detail = taskDetails[task.id]!;
  const pr = requests.find((pr) => pr.project === task.project && pr.number === task.pr?.number);
  const branch = detail.branch ?? pr?.branch;
  const tabs = SCREENS["task-detail"].states;
  const active = tabs.find((section) => section === tab) ?? "overview";
  const completed = detail.subtasks.filter((subtask) => subtask.status === "Completed").length;
  const agentCount = detail.agents.length;
  const subtitles = {
    overview: undefined,
    subtasks: detail.subtasks.length
      ? completed + " of " + detail.subtasks.length + " completed"
      : undefined,
    agents: agentCount
      ? agentCount + (agentCount === 1 ? " agent assigned" : " agents assigned")
      : undefined,
  };
  return (
    <RecordDetail
      identity={"Task #" + task.id}
      title={task.title}
      offline={offline}
      onBack={onBack}
      tab={active}
      onTab={onTab}
      navLabel="Task sections"
      tabs={tabs}
      subtitle={subtitles[active]}
      fields={
        <>
          {detail.workspace && (
            <DetailField icon="server" label="Workspace">
              {detail.workspace} · {task.node}
            </DetailField>
          )}
          {branch && (
            <DetailField icon="branch" label="Branch">
              {branch}
            </DetailField>
          )}
          {pr && (
            <DetailField icon="pull-request" label="Pull request">
              <button className="ios-detail-link" onClick={() => openPr(pr)}>
                #{pr.number} · {pr.state}
                <Icon name="chevron-right" size={13} />
              </button>
            </DetailField>
          )}
          {detail.usage && (
            <DetailField icon="clock" label="Usage">
              {detail.usage}
            </DetailField>
          )}
          {pr && (
            <DetailField icon="trend-up" label="Changes">
              <span className="ios-detail-diff">
                <span>+{pr.added}</span>
                <span>−{pr.removed}</span>
              </span>
            </DetailField>
          )}
        </>
      }
    >
      {active === "overview" && <MarkdownText markdown={detail.brief} />}
      {active === "subtasks" && <SubtasksList subtasks={detail.subtasks} />}
      {active === "agents" && <AgentsList agents={detail.agents} />}
    </RecordDetail>
  );
}
