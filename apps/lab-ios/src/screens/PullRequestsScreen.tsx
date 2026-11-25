import { useState } from "react";
import { requests, dotStates, prStatus, type LabPullRequest } from "../data/pullRequests";

import { FilteredListHeader } from "../components/FilteredListHeader";
import { ProjectListRow } from "../components/ProjectListRow";
import "./PullRequestsScreen.css";

const filters = ["All", "In progress", "Checks passed", "Checks failed", "Draft"] as const;
type Filter = (typeof filters)[number];

function matchesFilter(pr: LabPullRequest, filter: Filter) {
  const status = prStatus(pr);
  return filter === "All" || status === (filter === "In progress" ? "Checks running" : filter);
}

export function PullRequestsScreen({
  empty,
  query,
  light,
  onOpen,
}: {
  empty: boolean;
  query: string;
  light: boolean;
  onOpen: (pr: LabPullRequest) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const candidates = (empty ? [] : requests).filter(
    (pr) =>
      (pr.state === "Open" || pr.state === "Draft") &&
      [pr.title, pr.project, pr.repo, "#" + pr.number, pr.author, pr.environment, pr.label]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const rows = candidates.filter((pr) => matchesFilter(pr, filter));
  const inProgress = rows.filter((pr) => matchesFilter(pr, "In progress")).length;
  return (
    <section className="m-list ios-pr-list" aria-label="Pull requests">
      <div className="m-tasks-scroll m-scroll">
        <FilteredListHeader
          title="Pull Requests"
          subtitle={`${rows.length} open · ${inProgress} in progress`}
          filterLabel="Filter pull requests"
          options={filters.map((label) => ({
            label,
            count: candidates.filter((pr) => matchesFilter(pr, label)).length,
          }))}
          selected={filter}
          onSelect={setFilter}
        />
        {rows.map((pr) => (
          <ProjectListRow
            key={pr.repo + pr.number}
            project={pr.project}
            light={light}
            status={dotStates[prStatus(pr)]}
            statusLabel={pr.state + ", " + pr.checks}
            title={pr.title}
            onOpen={() => onOpen(pr)}
            titleTrailing={
              <span className="ios-pr-stats">
                <span>+{pr.added}</span>
                <span>−{pr.removed}</span>
              </span>
            }
          >
            <span className="ios-pr-byline">
              <span className="ios-pr-number">#{pr.number}</span>
              <i aria-hidden="true">·</i>
              <span>{pr.author}</span>
              <i aria-hidden="true">·</i>
              <span className="ios-pr-check-count">
                {pr.passedChecks} of {pr.totalChecks} passed
              </span>
              <span className="ios-pr-age">{pr.updated} ago</span>
            </span>
          </ProjectListRow>
        ))}
        {!rows.length && (
          <div className="ios-empty">
            <strong>{empty ? "No pull requests" : "No matching pull requests"}</strong>
            {empty && <p>Pull requests from connected environments will appear here.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
