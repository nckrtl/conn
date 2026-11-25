import { useState } from "react";
import { ProjectFavicon } from "../../../lab-ios/src/components/ProjectFavicon";
import { StatusDot } from "../../../lab-ios/src/components/StatusDot";
import { dotStates, prKey, prStatus } from "../../../lab-ios/src/data/pullRequests";
import { requests, reviewSample, type LabPullRequest } from "./desktopPullRequests";
import { Icon } from "./Icon";
import { currentTheme } from "./themes";
import "./PullRequestsPanel.css";

const filters = [
  "All",
  "Open",
  "In progress",
  "Checks passed",
  "Checks failed",
  "Draft",
  "Merged",
  "Closed",
] as const;
type Filter = (typeof filters)[number];

function matches(pr: LabPullRequest, filter: Filter) {
  if (filter === "All") return true;
  if (filter === "Open") return pr.state === "Open" || pr.state === "Draft";
  return prStatus(pr) === (filter === "In progress" ? "Checks running" : filter);
}

export function PullRequestsPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("Open");
  const [expanded, setExpanded] = useState<string | null>(null);
  const light = currentTheme().appearance === "light";
  const search = query.trim().toLowerCase();
  const candidates = requests.filter((pr) =>
    [prKey(pr), pr.title, pr.author, pr.branch, pr.project, pr.environment, pr.label]
      .join(" ")
      .toLowerCase()
      .includes(search),
  );
  const rows = candidates.filter((pr) => matches(pr, filter));

  return (
    <section className="pr-list" aria-label="Pull requests">
      <div className="pr-list-tools">
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search pull requests"
            placeholder="Search pull requests"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
        </label>
        <label className="pr-list-filter">
          <Icon name="filter" />
          <select
            aria-label="Filter pull requests"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            {filters.map((label) => (
              <option key={label} value={label}>
                {label} ({candidates.filter((pr) => matches(pr, label)).length})
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="pr-list-rows">
        {rows.map((pr) => {
          const id = prKey(pr);
          const open = expanded === id;
          const sample = reviewSample(pr);
          const checkSummary =
            pr.totalChecks === null ? pr.checks : `${pr.passedChecks} of ${pr.totalChecks} passed`;
          return (
            <li key={id}>
              <div className="pr-list-row">
                <button
                  type="button"
                  className="pr-list-open"
                  aria-label={`Open ${id}: ${pr.title}`}
                  onClick={() => onOpen(id)}
                >
                  <ProjectFavicon project={pr.project} light={light}>
                    <StatusDot
                      state={dotStates[prStatus(pr)]}
                      label={pr.state + ", " + pr.checks}
                      ring="var(--bg)"
                    />
                  </ProjectFavicon>
                  <span className="pr-list-title">{pr.title}</span>
                </button>
                <button
                  type="button"
                  disabled={!sample}
                  className="pr-list-stat"
                  data-tip="Change breakdown"
                  aria-label={`Change breakdown for #${pr.number}, ${pr.added} added, ${pr.removed} deleted`}
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : id)}
                >
                  <span>+{pr.added}</span>
                  <span>−{pr.removed}</span>
                </button>
                <div className="pr-list-metadata">
                  <span>#{pr.number}</span>
                  <i aria-hidden="true">·</i>
                  <span className="pr-list-author">{pr.author}</span>
                  <i aria-hidden="true">·</i>
                  <span>{checkSummary}</span>
                  <span className="pr-list-age">{pr.updated} ago</span>
                </div>
              </div>
              {open && sample && (
                <ul className="pr-list-changes" aria-label={`Changed files in #${pr.number}`}>
                  {sample.files.map((file) => (
                    <li key={file.path}>
                      <Icon name="file-code" />
                      <code data-tip={file.path}>{file.path}</code>
                      <span>+{file.additions}</span>
                      <span>−{file.deletions}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {!rows.length && (
        <div className="pr-list-empty">
          No matching pull requests
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setFilter("All");
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      <div className="pr-list-footer" role="status">
        {rows.length} of {requests.length} pull requests
      </div>
    </section>
  );
}
