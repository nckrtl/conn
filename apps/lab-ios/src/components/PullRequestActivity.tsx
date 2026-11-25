import { Icon, StatusRing } from "./Icon";
import { type CheckStatus, checkRuns } from "../data/pullRequestChecks";
import { prStatus, type LabPullRequest } from "../data/pullRequests";
import "./PullRequestActivity.css";

function CheckIndicator({ status }: { status: CheckStatus }) {
  return (
    <span
      className="ios-check-indicator"
      data-status={status}
      role="img"
      aria-label={status}
      data-tip={status}
    >
      {status === "Passed" || status === "Failed" ? (
        <Icon name={status === "Passed" ? "check-circle" : "error-circle"} size={18} />
      ) : (
        <StatusRing spinning={status === "Running"} />
      )}
    </span>
  );
}

export function CheckRows({ runs }: { runs: ReturnType<typeof checkRuns> }) {
  return runs.map(({ name, duration, status }) => (
    <div className="ios-check-row" key={name}>
      <CheckIndicator status={status} />
      <span>{name}</span>
      {/* oxlint-disable-next-line t3code/no-em-dash-copy -- The phone uses a dash for unavailable duration data. */}
      <small className="ios-check-duration">{status === "Queued" ? "—" : duration}</small>
    </div>
  ));
}
export function PullRequestTimeline({
  pr,
  comment,
  newestFirst = false,
}: {
  pr: Pick<LabPullRequest, "state" | "checks"> & { author: string; updated: string };
  comment?: string | undefined;
  newestFirst?: boolean;
}) {
  const events = [
    <li key="opened">
      <Icon name="pull-request" size={16} />
      <div>
        <strong>{pr.author}</strong> opened{" "}
        {pr.state === "Draft" ? "a draft pull request" : "the pull request"}.
      </div>
    </li>,
    comment && (
      <li key="review">
        <Icon name="comment-text" size={16} />
        <div>
          <strong>Review note</strong>
          <p>{comment}</p>
        </div>
      </li>
    ),
    <li key="status">
      <Icon name={pr.state === "Merged" ? "merge" : "clock"} size={16} />
      <div>
        <strong>{prStatus(pr)}</strong>
        <small>{pr.updated} ago</small>
      </div>
    </li>,
  ];
  return <ol className="ios-pr-timeline">{newestFirst ? events.reverse() : events}</ol>;
}
