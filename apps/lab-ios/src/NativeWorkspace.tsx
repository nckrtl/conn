import { ThreadSettingsSheet } from "./components/ThreadSettingsSheet";
import { OfflinePill } from "./components/OfflinePill";
import { lazy, Suspense, useState } from "react";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { GlassButton, GlassHeader } from "./components/GlassHeader";
import { CurrentSettingsSheet, type PreviewEnvironments } from "./components/CurrentSettingsSheet";
import { SettingsSheet, type PreviewPreferences } from "./components/SettingsSheet";
import { Composer } from "./components/Composer";

import { ThreadListScreen } from "./screens/ThreadListScreen";
import { PullRequestsScreen } from "./screens/PullRequestsScreen";
import { requests, prKey, type LabPullRequest } from "./data/pullRequests";
import { TasksScreen } from "./screens/TasksScreen";
import {
  APPROVAL_THREAD,
  TASKS,
  FEED_THREAD,
  LIST_THREADS,
  QUESTION_SCENARIOS,
  WORKING_THREADS,
  type LabThread,
  type LabAttachment,
  type ListThread,
} from "./data/fixtures";
import { demoThread, listRow, demoFilingProject } from "./data/iosDemo";
import type { LabUrlState } from "./urlState";

const TaskDetailScreen = lazy(() => import("./screens/TaskDetailScreen"));
const PullRequestDetailScreen = lazy(() => import("./screens/PullRequestDetailScreen"));
const ThreadScreen = lazy(async () => ({
  default: (await import("./screens/ThreadScreen")).ThreadScreen,
}));
export function usePhoneFixtures() {
  const [preferences, setPreferences] = useState<PreviewPreferences>({});
  const [environments, setEnvironments] = useState<PreviewEnvironments>({
    paired: true,
    linked: false,
  });
  const storageKey = "conn.ios-lab.threads.v1";
  const [threads, setThreads] = useState<LabThread[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (
        Array.isArray(saved) &&
        saved.length &&
        saved.every(
          (t) =>
            t &&
            typeof t.key === "string" &&
            typeof t.title === "string" &&
            typeof t.model === "string" &&
            Array.isArray(t.entries),
        )
      )
        return saved;
    } catch {
      /* Use the bundled fixtures if the local preview cache is unavailable. */
    }
    return [demoThread];
  });
  function remember(t: LabThread) {
    const next = [t, ...threads.filter((v) => v.key !== t.key)];
    setThreads(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Changes are still available for the current preview. */
    }
  }
  return { threads, remember, preferences, setPreferences, environments, setEnvironments };
}
export function NativeWorkspace({
  url,
  update,
  fixtures,
  light,
}: {
  url: LabUrlState;
  update: (patch: Partial<LabUrlState>) => void;
  fixtures: ReturnType<typeof usePhoneFixtures>;
  light: boolean;
}) {
  const { screen, state } = url;
  const offline = url.launch === "offline";
  const [search, setSearch] = useState(false),
    [query, setQuery] = useState(""),
    [sheet, setSheet] = useState(""),
    [draft, setDraft] = useState(
      screen === "new-chat" && state === "example" ? "Fix image attachments in Conn." : "",
    );

  const workspace = screen === "tasks" || screen === "thread-list" || screen === "pull-requests";
  const scopeKey =
    screen === "thread-approval" ? APPROVAL_THREAD.key : url.thread || FEED_THREAD.key;
  const selected =
    fixtures.threads.find((t) => t.key === scopeKey) ??
    (scopeKey === APPROVAL_THREAD.key
      ? APPROVAL_THREAD
      : scopeKey === FEED_THREAD.key
        ? FEED_THREAD
        : demoThread);
  const question =
    screen === "thread-question"
      ? (QUESTION_SCENARIOS[state] ?? QUESTION_SCENARIOS.single!)
      : undefined;
  const thread = question
    ? (fixtures.threads.find((t) => t.key === question.thread.key) ?? question.thread)
    : selected;
  const model = thread.model;
  function go(next: LabUrlState["screen"], id = "") {
    setSearch(false);
    setQuery("");
    setSheet("");
    update({ screen: next, thread: id });
  }
  const closeSheet = () => (screen === "settings" ? go("thread-list") : setSheet(""));
  const detail = screen === "task-detail" || screen === "pr-detail";
  const openTask = (id: number) => update({ screen: "task-detail", item: String(id) });
  const openPr = (pr: LabPullRequest) => update({ screen: "pr-detail", item: prKey(pr) });
  function backFromDetail() {
    if (window.history.state?.fromScreen) window.history.back();
    else go(screen === "task-detail" ? "tasks" : "pull-requests");
  }
  const task = url.item ? TASKS.find((task) => String(task.id) === url.item) : TASKS[0];
  const pr = url.item ? requests.find((pr) => prKey(pr) === url.item) : requests[0];
  const detailProps = {
    offline,
    tab: state,
    onTab: (tab: string) => update({ state: tab }),
    onBack: backFromDetail,
  };
  function open(row: ListThread) {
    const existing = fixtures.threads.find((t) =>
      row.key ? t.key === row.key : t.title === row.title,
    );
    const t = existing ?? {
      ...FEED_THREAD,
      key: row.title,
      title: row.title,
      project: row.project,
      branch: row.branch ?? "",
      instanceId: row.provider,
    };
    if (!existing) fixtures.remember(t);
    go("thread", t.key);
  }
  function send(text: string, attachments: readonly LabAttachment[] = []) {
    fixtures.remember({
      ...thread,
      project:
        thread.startedInGeneral && thread.project === "General"
          ? demoFilingProject(text)
          : thread.project,
      entries: [...thread.entries, { kind: "user", text, attachments, minutesAgo: 0 }],
    });
  }
  const rows = fixtures.threads.map(listRow);
  return (
    <>
      {(screen === "thread-list" || screen === "settings") && (
        <ThreadListScreen
          light={light}
          rows={
            state === "populated"
              ? [
                  ...rows,
                  ...[...LIST_THREADS, ...WORKING_THREADS].filter(
                    (r) => !rows.some((t) => t.title === r.title),
                  ),
                ]
              : rows
          }
          open={open}
          query={query}
        />
      )}
      {(screen === "tasks" || detail) && (
        <div hidden={screen !== "tasks"}>
          <TasksScreen
            light={light}
            onOpen={openTask}
            loaded={detail || state !== "unavailable"}
            insights={url.insights}
            chart={state === "chart"}
            query={query}
          />
        </div>
      )}
      {(screen === "pull-requests" || detail) && (
        <div hidden={screen !== "pull-requests"}>
          <PullRequestsScreen
            onOpen={openPr}
            light={light}
            empty={!detail && state === "empty"}
            query={query}
          />
        </div>
      )}
      <Suspense fallback={null}>
        {screen === "task-detail" && task && (
          <TaskDetailScreen {...detailProps} task={task} openPr={openPr} />
        )}
        {screen === "pr-detail" && pr && (
          <PullRequestDetailScreen
            key={prKey(pr)}
            {...detailProps}
            pr={pr}
            light={light}
            openTask={openTask}
            filePath={url.file}
            openFile={(file) => update({ file })}
            backToCode={() =>
              window.history.state?.fromCodeList ? window.history.back() : update({ file: "" })
            }
          />
        )}
      </Suspense>
      {((screen === "task-detail" && !task) || (screen === "pr-detail" && !pr)) && (
        <>
          <GlassHeader
            title="Detail unavailable"
            leading={<GlassButton icon="chevron-left" label="Back" onClick={backFromDetail} />}
          />
          <div className="ios-record-scroll ios-detail-body">
            This item is unavailable in the lab.
          </div>
        </>
      )}
      {workspace && (
        <WorkspaceBar
          offline={offline}
          active={screen}
          onTab={(tab) => go(tab)}
          onSettings={() => setSheet("settings")}
          onNew={() => {
            setDraft("");
            go("new-chat");
          }}
          searching={search}
          onSearch={(s) => {
            setSearch(s);
            setQuery("");
          }}
          query={query}
          onQuery={setQuery}
        />
      )}
      {(screen === "thread" || screen === "thread-question" || screen === "thread-approval") && (
        <Suspense fallback={null}>
          <ThreadScreen
            key={question ? thread.key + state : thread.key}
            offline={offline}
            thread={thread}
            agentMessageCards={screen === "thread"}
            scenarioId={question ? state : undefined}
            approvalExample={
              screen === "thread-approval"
                ? state === "long" || state === "session" || state === "two" || state === "six"
                  ? state
                  : "command"
                : undefined
            }
            onOpenTask={openTask}
            onBack={() => go("thread-list")}
            onSend={send}
            finishQuestion={(answer) => {
              if (answer) send(answer);
              else fixtures.remember(thread);
              go("thread", thread.key);
            }}
            model={model}
            provider={thread.instanceId}
            onModel={() => setSheet("models")}
          />
        </Suspense>
      )}
      {screen === "new-chat" && (
        <div className="ios-new">
          <GlassHeader
            title="New thread"
            leading={
              <GlassButton icon="chevron-left" label="Back" onClick={() => go("thread-list")} />
            }
          />
          <div className="ios-hero">What should we work on?</div>
          {offline && <OfflinePill />}
          <div className="m-thread-bottom" inert={offline}>
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={(attachments) => {
                const text = draft.trim();
                const title = text || attachments[0]?.name;
                if (!title) return;
                const t: LabThread = {
                  key: "draft-" + (fixtures.threads.length + 1),
                  startedInGeneral: true,
                  project: demoFilingProject(text),
                  instanceId: demoThread.instanceId,
                  model: demoThread.model,
                  title,
                  minutesAgo: 0,
                  entries: [{ kind: "user", minutesAgo: 0, text, attachments }],
                };
                fixtures.remember(t);
                setDraft("");
                go("thread", t.key);
              }}
            />
          </div>
        </div>
      )}
      {(sheet || screen === "settings") && (
        <>
          <button className="ios-scrim" aria-label="Dismiss sheet" onClick={closeSheet} />
          {sheet === "models" ? (
            <ThreadSettingsSheet
              thread={thread}
              close={() => setSheet("")}
              save={(settings) => {
                fixtures.remember({ ...thread, ...settings });
                setSheet("");
              }}
            />
          ) : screen === "settings" && state === "proposed" ? (
            <SettingsSheet
              light={light}
              offline={offline}
              preferences={fixtures.preferences}
              onChange={(key, value) =>
                fixtures.setPreferences((current) => ({ ...current, [key]: value }))
              }
              close={closeSheet}
            />
          ) : (
            <CurrentSettingsSheet
              environments={fixtures.environments}
              change={fixtures.setEnvironments}
              offline={offline}
              reconnect={() => {
                if (offline && url.connection === "online") update({ launch: "workspace" });
              }}
              close={closeSheet}
            />
          )}
        </>
      )}
    </>
  );
}
