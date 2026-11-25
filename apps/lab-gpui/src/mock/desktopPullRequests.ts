import {
  requests as sharedRequests,
  reviewSamples,
  type LabPullRequest as SharedRequest,
} from "../../../lab-ios/src/data/pullRequests";
import { sidebarSweep } from "../pr/sidebarSweep";

const desktopRequest = {
  number: sidebarSweep.number,
  repo: sidebarSweep.repository,
  title: sidebarSweep.title,
  branch: sidebarSweep.head,
  author: sidebarSweep.author,
  added: sidebarSweep.additions,
  removed: sidebarSweep.deletions,
  updated: sidebarSweep.updatedHoursAgo + "h",
  project: "Conn",
  state: "Merged",
  checks: "Checks passed",
  label: "enhancement",
  environment: "",
  body: "Select a range of threads by sweeping across the sidebar.",
  totalChecks: null,
  passedChecks: null,
} as const;
export type LabPullRequest = SharedRequest | typeof desktopRequest;
export const requests: readonly LabPullRequest[] = [...sharedRequests, desktopRequest];
export function reviewSample(pr: LabPullRequest) {
  return pr.number === desktopRequest.number ? undefined : reviewSamples[pr.number];
}
