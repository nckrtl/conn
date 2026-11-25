import { useId, useState } from "react";
import HighlightedCode from "../../../lab-ios/src/components/HighlightedCode";
import { copyFeedText } from "../../../lab-ios/src/components/copyFeedText";
import { TASKS } from "../../../lab-ios/src/data/fixtures";
import {
  CheckRows,
  PullRequestTimeline,
} from "../../../lab-ios/src/components/PullRequestActivity";
import { filteredChecks, type CheckFilter } from "../../../lab-ios/src/data/pullRequestChecks";
import { prKey, type PrFileChange } from "../../../lab-ios/src/data/pullRequests";
import { requests, reviewSample, type LabPullRequest } from "./desktopPullRequests";
import { tasks as desktopTasks } from "./fixtures";
import { Icon, Tool } from "./Icon";
import "./DetailTabs.css";
import "./PullRequestDetailPanel.css";

type Props = {
  id: string;
  onBack: () => void;
  onOpenTask?: (id: number) => void;
  section?: string | undefined;
  file?: string | undefined;
  onNavigate?: (section: string, file?: string) => void;
};

const sections = {
  summary: "Description",
  checks: "Checks",
  timeline: "Timeline",
  code: "Code",
} as const;
type Section = keyof typeof sections;

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="pr-detail-counts">
      <b>+{added}</b>
      <b>−{removed}</b>
    </span>
  );
}

function Patch({ file, wrap }: { file: PrFileChange; wrap: boolean }) {
  const languageByExtension: Record<string, string> = {
    php: "php",
    swift: "swift",
    ts: "typescript",
    tsx: "tsx",
    vue: "xml",
  };
  const language = languageByExtension[file.path.split(".").pop() ?? ""] ?? "";
  let oldNumber = 0;
  let newNumber = 0;
  return (
    <div
      className="pr-detail-patch"
      aria-label={`Diff for ${file.path}`}
      role="region"
      tabIndex={0}
      data-wrap={wrap}
    >
      <div className="pr-detail-patch-inner">
        {file.excerpt.map((line) => {
          const sign = line[0] ?? " ";
          const before = sign !== "+" ? ++oldNumber : "";
          const after = sign !== "-" ? ++newNumber : "";
          return (
            <div className="pr-detail-line" key={`${before}:${after}`} data-change={sign}>
              <span aria-hidden="true">{before}</span>
              <span aria-hidden="true">{after}</span>
              <span aria-hidden="true">{sign}</span>
              <code>
                <HighlightedCode language={language} code={line.slice(1) || " "} />
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PullRequestDetailPanel(props: Props) {
  const pr = requests.find(
    (candidate) => prKey(candidate) === props.id || String(candidate.number) === props.id,
  );
  if (!pr)
    return (
      <div className="pr-detail-unavailable">
        <p>Pull request unavailable in this preview.</p>
        <button onClick={props.onBack}>Back to pull requests</button>
      </div>
    );
  return <PullRequestRecord key={prKey(pr)} {...props} pr={pr} />;
}

function PullRequestRecord({
  pr,
  onBack,
  onOpenTask,
  section,
  file,
  onNavigate,
}: Props & { pr: LabPullRequest }) {
  const [localRoute, setLocalRoute] = useState<{ section: Section; file?: string | undefined }>({
    section: "summary",
  });
  const [condensed, setCondensed] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [newest, setNewest] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy branch");
  const sample = reviewSample(pr);
  const activeKey = section ?? (onNavigate ? "summary" : localRoute.section);
  const active: Section = Object.hasOwn(sections, activeKey) ? (activeKey as Section) : "summary";
  const path = file ?? (onNavigate ? undefined : localRoute.file);
  const selected = path ? sample?.files.find((entry) => entry.path === path) : sample?.files[0];
  const linkedTask =
    TASKS.find((task) => task.project === pr.project && task.pr?.number === pr.number) ??
    desktopTasks.find((task) => pr.project === "Conn" && task.pr === pr.number);
  const [checkFilter, setCheckFilter] = useState<CheckFilter>("All");
  const filterId = useId();
  const checks = pr.totalChecks === null ? null : filteredChecks(pr, checkFilter);

  function navigate(next: Section, nextFile?: string) {
    if (onNavigate) onNavigate(next, nextFile);
    else setLocalRoute({ section: next, file: nextFile });
  }
  function toggleViewed(path: string) {
    setViewed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  return (
    <section className="pr-detail" aria-label={`Pull request #${pr.number}`}>
      <nav className="pr-detail-nav" aria-label="Pull request breadcrumb">
        <button onClick={onBack}>
          <Icon name="chevron-left" /> Pull requests
        </button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">#{pr.number}</span>
      </nav>
      <div className="pr-detail-title">
        <h2 data-tip={pr.title}>{pr.title}</h2>
        <span className="pr-detail-state" data-state={pr.state}>
          {pr.state}
        </span>
        <Tool
          label={condensed ? "Show details" : "Hide details"}
          icon={condensed ? "chevron-down" : "chevron-up"}
          aria-expanded={!condensed}
          onClick={() => setCondensed(!condensed)}
        />
      </div>
      {!condensed && (
        <dl className="pr-detail-meta">
          <div>
            <dt>
              <Icon name="folder-git" />
              Repository
            </dt>
            <dd>{pr.repo}</dd>
          </div>
          <div>
            <dt>
              <Icon name="agent" />
              Author
            </dt>
            <dd>{pr.author}</dd>
          </div>
          <div>
            <dt>
              <Icon name="clock" />
              Updated at
            </dt>
            <dd>{pr.updated} ago</dd>
          </div>
          <div>
            <dt>
              <Icon name="branch" />
              Branch
            </dt>
            <dd>
              <span className="pr-detail-branch">{pr.branch} → main</span>
              <Tool
                label={copyLabel}
                icon={copyLabel === "Branch copied" ? "check" : "copy"}
                onClick={async () =>
                  setCopyLabel(
                    (await copyFeedText(pr.branch)) ? "Branch copied" : "Copy unavailable",
                  )
                }
              />
            </dd>
          </div>
          <div>
            <dt>
              <Icon name="file-diff" />
              Changes
            </dt>
            <dd>
              <Counts added={pr.added} removed={pr.removed} />
            </dd>
          </div>
          <div>
            <dt>
              <Icon name="layers" />
              Labels
            </dt>
            <dd>
              <span className="pr-detail-label">{pr.label}</span>
            </dd>
          </div>
          {linkedTask && onOpenTask && (
            <div>
              <dt>
                <Icon name="checklist" />
                Task
              </dt>
              <dd>
                <button className="pr-detail-link" onClick={() => onOpenTask(linkedTask.id)}>
                  #{linkedTask.id} · {linkedTask.title}
                </button>
              </dd>
            </div>
          )}
        </dl>
      )}
      <nav className="detail-tabs" aria-label="Pull request sections">
        {(Object.keys(sections) as Section[]).map((tab) => (
          <button key={tab} aria-pressed={tab === active} onClick={() => navigate(tab)}>
            {sections[tab]}
          </button>
        ))}
      </nav>
      {active === "summary" && (
        <div className="pr-detail-description">
          <p>{pr.body}</p>
          {sample && <p>{sample.summary}</p>}
        </div>
      )}
      {active === "checks" && (
        <section className="pr-detail-activity" aria-label="Checks">
          <div className="pr-detail-toolbar">
            <div className="pr-activity-heading">
              <strong>Checks</strong>
              <small>{checks?.summary ?? pr.checks}</small>
            </div>
            {checks && (
              <>
                <Tool icon="filter" label="Filter checks" popoverTarget={filterId} />
                <div
                  id={filterId}
                  popover="auto"
                  className="pr-check-filter"
                  role="group"
                  aria-label="Check status"
                >
                  {checks.options.map(({ label, count }) => (
                    <button
                      key={label}
                      aria-pressed={label === checkFilter}
                      onClick={(event) => {
                        setCheckFilter(label);
                        event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                      }}
                    >
                      {label} · {count}
                      {label === checkFilter && <Icon name="check" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {checks ? (
            <div className="pr-activity-body">
              <CheckRows runs={checks.visible} />
            </div>
          ) : (
            <p>Individual check runs are unavailable in this preview.</p>
          )}
        </section>
      )}
      {active === "timeline" && (
        <section
          className="pr-detail-activity pr-activity-body pr-timeline"
          aria-label="Pull request timeline"
        >
          <button type="button" className="pr-timeline-order" onClick={() => setNewest(!newest)}>
            {newest ? "Newest first" : "Oldest first"}
            <Icon name="device-rotate" />
          </button>
          <PullRequestTimeline pr={pr} comment={sample?.comment} newestFirst={newest} />
        </section>
      )}
      {active === "code" && !sample && <p>File patches are unavailable in this preview.</p>}
      {active === "code" && sample && (
        <section aria-label="Pull request code">
          <div className="pr-detail-toolbar">
            <strong>
              {sample.files.length} changed {sample.files.length === 1 ? "file" : "files"}
            </strong>
            <span>
              {viewed.size}/{sample.files.length} viewed
            </span>
            <div className="pr-detail-tools">
              <Tool
                icon="files"
                label="Show changed file list"
                aria-pressed={treeOpen}
                onClick={() => setTreeOpen(!treeOpen)}
              />
              <Tool
                icon="wrap-lines"
                label="Wrap diff lines"
                aria-pressed={wrap}
                onClick={() => setWrap(!wrap)}
              />
            </div>
          </div>
          <div className="pr-detail-code">
            {treeOpen && (
              <nav className="pr-detail-files" aria-label="Changed files">
                {sample.files.map((entry) => (
                  <button
                    key={entry.path}
                    aria-label={`View diff for ${entry.path}`}
                    data-tip={entry.path}
                    aria-pressed={entry.path === selected?.path}
                    onClick={() => navigate("code", entry.path)}
                  >
                    <Icon name={viewed.has(entry.path) ? "check" : "file-diff"} />
                    <span dir="rtl">
                      <bdi>{entry.path}</bdi>
                    </span>
                    <Counts added={entry.additions} removed={entry.deletions} />
                  </button>
                ))}
              </nav>
            )}
            <div className="pr-detail-file">
              {selected ? (
                <>
                  <div className="pr-detail-file-head">
                    <strong>{selected.path}</strong>
                    <label>
                      <input
                        type="checkbox"
                        checked={viewed.has(selected.path)}
                        onChange={() => toggleViewed(selected.path)}
                      />{" "}
                      Viewed
                    </label>
                  </div>
                  <Patch file={selected} wrap={wrap} />
                </>
              ) : (
                <p>{path ? "File unavailable in this preview." : "No changed files."}</p>
              )}
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
