import type { LabPullRequest } from "./pullRequests";

// Durations are snapshots of the fixture runs, including elapsed time for an active check.
const checks = [
  ["Formatting", "8s"],
  ["Lint", "24s"],
  ["Typecheck", "1m 12s"],
  ["Unit tests", "2m 38s"],
  ["Build", "46s"],
  ["Contract tests", "52s"],
  ["Integration tests", "3m 17s"],
  ["Browser tests", "2m 54s"],
  ["Review", "35s"],
  ["End-to-end tests", "4m 11s"],
  ["Package", "42s"],
  ["Preview deployment", "1m 6s"],
] as const;
export const checkFilters = ["All", "Passed", "Running", "Queued", "Failed"] as const;
export type CheckFilter = (typeof checkFilters)[number];
export type CheckStatus = Exclude<CheckFilter, "All">;

function checkStatus(pr: LabPullRequest, index: number): CheckStatus {
  if (index < pr.passedChecks) return "Passed";
  if (pr.checks === "Checks failed") return "Failed";
  return index === pr.passedChecks ? "Running" : "Queued";
}

export function checkRuns(pr: LabPullRequest) {
  return checks.slice(0, pr.totalChecks).map(([name, duration], index) => ({
    name,
    duration,
    status: checkStatus(pr, index),
  }));
}

export function filteredChecks(pr: LabPullRequest, filter: CheckFilter) {
  const runs = checkRuns(pr);
  const options = checkFilters
    .map((label) => ({
      label,
      count: label === "All" ? runs.length : runs.filter((run) => run.status === label).length,
    }))
    .filter((option) => option.count > 0);
  const visible = filter === "All" ? runs : runs.filter((run) => run.status === filter);
  const summary =
    filter === "All"
      ? `${pr.passedChecks} of ${pr.totalChecks} checks passed`
      : `${visible.length} of ${pr.totalChecks} checks ${filter.toLowerCase()}`;
  return { visible, options, summary };
}
