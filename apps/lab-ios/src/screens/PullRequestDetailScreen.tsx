import { lazy, Suspense, useState } from "react";
import { PierreEntryIcon } from "../../../lab-shared/PierreEntryIcon";
import { DetailField, RecordDetail } from "../components/RecordDetail";
import { FilterMenu } from "../components/FilteredListHeader";
import { GlassButton, GlassHeader } from "../components/GlassHeader";
import { OfflinePill } from "../components/OfflinePill";
import { CheckRows, PullRequestTimeline } from "../components/PullRequestActivity";
import { Icon } from "../components/Icon";
import { MarkdownText } from "../components/Markdown";
import { TASKS } from "../data/fixtures";
import {
  fileFilters,
  reviewSamples,
  type FileFilter,
  type LabPullRequest,
  type PrFileChange,
} from "../data/pullRequests";
import { filteredChecks, type CheckFilter } from "../data/pullRequestChecks";
import { SCREENS } from "../urlState";

const PullRequestFileDiff = lazy(() => import("../components/PullRequestFileDiff"));

function fileParts(path: string) {
  const slash = path.lastIndexOf("/");
  return { name: path.slice(slash + 1), directory: slash >= 0 ? path.slice(0, slash) : "" };
}

function FileStats({ file }: { file: PrFileChange }) {
  return (
    <span
      className="ios-detail-diff ios-file-stats"
      aria-label={file.additions + " additions, " + file.deletions + " deletions"}
    >
      <span hidden={file.additions === 0}>+{file.additions}</span>
      <span hidden={file.deletions === 0}>−{file.deletions}</span>
    </span>
  );
}

function FileDetail({
  path,
  file,
  onBack,
  offline,
  light,
}: {
  path: string;
  file: PrFileChange | undefined;
  onBack: () => void;
  offline: boolean;
  light: boolean;
}) {
  const { name } = fileParts(path);
  return (
    <section className="ios-record ios-file-detail" aria-label={"Changes to " + path}>
      <GlassHeader
        title={name}
        subtitle={file && <FileStats file={file} />}
        leading={<GlassButton icon="chevron-left" label="Back to Code" onClick={onBack} />}
      />
      <div className="ios-record-scroll m-scroll">
        <div className="ios-detail-body">
          {file ? (
            <Suspense fallback={null}>
              <PullRequestFileDiff file={file} light={light} />
            </Suspense>
          ) : (
            <p>File unavailable in this preview.</p>
          )}
        </div>
      </div>
      {offline && (
        <div className="ios-file-status">
          <OfflinePill />
        </div>
      )}
    </section>
  );
}

export default function PullRequestDetailScreen({
  pr,
  offline,
  light,
  tab,
  onTab,
  onBack,
  openTask,
  filePath,
  openFile,
  backToCode,
}: {
  pr: LabPullRequest;
  offline: boolean;
  light: boolean;
  tab: string;
  onTab: (t: string) => void;
  onBack: () => void;
  openTask: (id: number) => void;
  filePath: string;
  openFile: (path: string) => void;
  backToCode: () => void;
}) {
  const task = TASKS.find((task) => task.project === pr.project && task.pr?.number === pr.number);
  const sample = reviewSamples[pr.number];
  const [filter, setFilter] = useState<FileFilter>("Changed");
  const filterOptions = fileFilters
    .map((label) => ({
      label,
      count: sample.files.filter((file) => label === "Changed" || file.status === label).length,
    }))
    .filter((option) => option.count > 0);
  const activeFilter = filterOptions.some(({ label }) => label === filter) ? filter : "Changed";
  const files = sample.files.filter(
    (file) => activeFilter === "Changed" || file.status === activeFilter,
  );
  const [checkFilter, setCheckFilter] = useState<CheckFilter>("All");
  const checks = filteredChecks(pr, checkFilter);
  const active = SCREENS["pr-detail"].states.find((section) => section === tab) ?? "overview";
  const subtitles = {
    overview: undefined,
    checks: checks.summary,
    timeline: "Updated " + pr.updated + " ago",
    code: `${files.length} ${activeFilter.toLowerCase()} ${files.length === 1 ? "file" : "files"}`,
  };
  if (active === "code" && filePath) {
    return (
      <FileDetail
        path={filePath}
        file={sample.files.find((file) => file.path === filePath)}
        onBack={backToCode}
        offline={offline}
        light={light}
      />
    );
  }
  return (
    <RecordDetail
      identity={"Pull request #" + pr.number}
      navLabel="Pull request sections"
      tabs={SCREENS["pr-detail"].states}
      tab={active}
      subtitle={subtitles[active]}
      headerAction={
        active === "checks" ? (
          <FilterMenu
            key="checks"
            filterLabel="Filter checks"
            options={checks.options}
            selected={checkFilter}
            onSelect={setCheckFilter}
          />
        ) : (
          active === "code" &&
          filterOptions.length > 2 && (
            <FilterMenu
              filterLabel="Filter files"
              options={filterOptions}
              selected={activeFilter}
              onSelect={setFilter}
            />
          )
        )
      }
      onTab={onTab}
      offline={offline}
      onBack={onBack}
      title={pr.title}
      fields={
        <>
          <DetailField icon="folder" label="Repository">
            {pr.repo}
          </DetailField>
          {task && (
            <DetailField icon="checklist" label="Task">
              <button className="ios-detail-link" onClick={() => openTask(task.id)}>
                #{task.id} · {task.title}
                <Icon name="chevron-right" size={13} />
              </button>
            </DetailField>
          )}
          <DetailField icon="users" label="Author">
            {pr.author} · {pr.updated} ago
          </DetailField>
          <DetailField icon="branch" label="Branch">
            {pr.branch} → main
          </DetailField>
          <DetailField icon="trend-up" label="Changes">
            <span className="ios-detail-diff">
              <span>+{pr.added}</span>
              <span>−{pr.removed}</span>
            </span>
          </DetailField>
        </>
      }
    >
      {active === "overview" && <MarkdownText markdown={pr.body + "\n\n" + sample.summary} />}
      {active === "checks" && <CheckRows runs={checks.visible} />}
      {active === "timeline" && <PullRequestTimeline pr={pr} comment={sample.comment} />}
      {active === "code" && files.length === 0 && (
        <p className="ios-detail-muted" role="status">
          No changed files
        </p>
      )}
      {active === "code" &&
        files.map((file) => {
          const { name, directory } = fileParts(file.path);
          return (
            <button
              type="button"
              className="ios-file-row"
              key={file.path}
              aria-label={
                "View diff for " +
                file.path +
                ", " +
                file.additions +
                " additions, " +
                file.deletions +
                " deletions"
              }
              onClick={() => openFile(file.path)}
            >
              <span className="ios-file-type" aria-hidden="true">
                {name.toLowerCase().endsWith(".php") ? (
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2 12a7 7 0 0 1 7-7h3a6 6 0 0 1 10 4.5V16c0 2.5-1.3 4-3.3 4-1.7 0-2.9-1.1-3-2.8h1.8c.1.6.5.9 1 .9.7 0 1-.6 1-1.6v-2.8a6 6 0 0 1-3.5.3l-.7 5.8h-3.2l-.6-4.3a10 10 0 0 1-4.8-.2L6 19.8H2.8L2 13.5l-.5 2.2L.3 15l.8-3.6Z" />
                    <path
                      d="M11.3 7.5c-.8 3.1.6 5.6 3.4 6l1-4.8"
                      fill="none"
                      stroke="var(--color-screen)"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                    <circle cx="19" cy="9" r=".9" fill="var(--color-screen)" />
                  </svg>
                ) : (
                  <PierreEntryIcon
                    pathValue={file.path}
                    kind="file"
                    theme={light ? "light" : "dark"}
                  />
                )}
              </span>
              <span className="ios-file-name">{name}</span>
              <FileStats file={file} />
              {directory && <span className="ios-file-directory">{directory}</span>}
            </button>
          );
        })}
    </RecordDetail>
  );
}
