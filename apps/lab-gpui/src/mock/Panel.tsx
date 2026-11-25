import { lazy, Suspense, useId, useState } from "react";
import { Icon, Tool } from "./Icon";
import { panels, tasks, type Panel } from "./fixtures";
import { TASKS } from "../../../lab-ios/src/data/fixtures";
import { FilesPanel, type FileLocation, type FileSelection } from "./FilesPanel";
import { PullRequestsPanel } from "./PullRequestsPanel";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { TaskInsights, metricOptions, periods, type Period } from "./TaskInsights";
import { TaskDetailPanel } from "./TaskDetailPanel";

const ApiPanel = lazy(async () => ({ default: (await import("./ApiPanel")).ApiPanel }));
const McpPanel = lazy(async () => ({ default: (await import("./McpPanel")).McpPanel }));
const DatabasePanel = lazy(async () => ({
  default: (await import("./DatabasePanel")).DatabasePanel,
}));
const workspacePanels = { Database: DatabasePanel, MCP: McpPanel, API: ApiPanel } as const;

const panelIcons: Record<Panel, string> = {
  Tasks: "checklist",
  Files: "files",
  "Pull requests": "pull-request",
  Database: "database",
  MCP: "mcp",
  API: "webhook",
};

export function SidePanel({
  panel,
  maximized,
  onMaximize,
  item,
  section,
  file,
  reveal,
  onAddSelection,
  onFile,
  onTask,
  onPr,
  onSection,
  seam,
  onPanel,
  onClose,
}: {
  panel: Panel;
  maximized: boolean;
  onMaximize: () => void;
  item: string;
  section: string;
  file: string;
  reveal: FileLocation | undefined;
  onFile: (location: FileLocation | null) => void;
  onAddSelection: (selection: FileSelection) => void;
  onTask: (id: number | null) => void;
  onPr: (id: string | null) => void;
  onSection: (section: string, file?: string) => void;
  seam: import("react").ReactNode;
  onPanel: (panel: Panel) => void;
  onClose: () => void;
}) {
  const [openTabs, setOpenTabs] = useState<Panel[]>([panel]);
  if (!openTabs.includes(panel)) setOpenTabs([...openTabs, panel]);
  const [menu, setMenu] = useState(false);
  return (
    <aside className="panel" aria-label="Right panel">
      {seam}
      <header>
        <div className="panel-tabs">
          {openTabs.map((tab) => (
            <button
              key={tab}
              className="panel-tab"
              aria-pressed={tab === panel}
              onClick={() => {
                if (tab !== panel) onPanel(tab);
              }}
            >
              <Icon name={panelIcons[tab]} />
              {tab}
            </button>
          ))}
        </div>
        <Tool icon="add" label="Add panel" aria-expanded={menu} onClick={() => setMenu(!menu)} />
        <div className="spacer" />
        <Tool
          icon={maximized ? "minimize" : "maximize"}
          label={maximized ? "Restore right panel" : "Maximize right panel"}
          onClick={onMaximize}
        />
        <Tool icon="sidebar-right" label="Close panel" onClick={onClose} />
        {menu && (
          <div className="menu">
            {panels.map((p) => (
              <button
                key={p}
                onClick={() => {
                  if (p !== panel) onPanel(p);
                  setMenu(false);
                }}
              >
                <Icon name={panelIcons[p]} />
                {p}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="panel-body">
        {panel === "Tasks" &&
          (item ? (
            <TaskDetailPanel
              key={item}
              id={Number(item)}
              section={section}
              onNavigate={onSection}
              onBack={() => onTask(null)}
              onOpenPr={onPr}
            />
          ) : (
            <TaskBoard onTask={onTask} />
          ))}
        {panel === "Pull requests" &&
          (item ? (
            <PullRequestDetailPanel
              key={item}
              id={item}
              section={section}
              file={file}
              onNavigate={onSection}
              onBack={() => onPr(null)}
              onOpenTask={onTask}
            />
          ) : (
            <PullRequestsPanel onOpen={onPr} />
          ))}
        {panel === "Files" && (
          <FilesPanel reveal={reveal} onNavigate={onFile} onAddSelection={onAddSelection} />
        )}
        {openTabs.map((tab) => {
          if (tab !== "Database" && tab !== "MCP" && tab !== "API") return null;
          const Workspace = workspacePanels[tab];
          return (
            <div key={tab} hidden={tab !== panel} className="panel-workspace">
              <Suspense fallback={null}>
                <Workspace />
              </Suspense>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const searchTask = tasks[1];
const boardTasks = [
  ...TASKS,
  {
    id: searchTask.id,
    title: searchTask.title,
    project: "Conn",
    lane: searchTask.status,
    subtasks: "2/" + searchTask.subtasks.length,
    node: "beast",
  },
];
const boardLanes = ["Backlog", "To do", "In progress", "In review", "Done"];
type BoardPreferences = { lanes: string[]; metrics: string[]; period: Period };
const boardStorage = "conn.gpui-lab.task-board";
const defaultBoard: BoardPreferences = { lanes: [], metrics: [], period: "30d" };
function readBoard(): BoardPreferences {
  try {
    const saved = JSON.parse(
      localStorage.getItem(boardStorage) ?? "null",
    ) as Partial<BoardPreferences> | null;
    if (!saved) return defaultBoard;
    const lanes = boardLanes.filter(
      (lane) => Array.isArray(saved.lanes) && saved.lanes.includes(lane),
    );
    return {
      lanes: lanes.length < boardLanes.length ? lanes : [],
      metrics: metricOptions
        .map((metric) => metric.id)
        .filter((id) => Array.isArray(saved.metrics) && saved.metrics.includes(id)),
      period: saved.period && Object.hasOwn(periods, saved.period) ? saved.period : "30d",
    };
  } catch {
    return defaultBoard;
  }
}
function TaskBoard({ onTask }: { onTask: (id: number) => void }) {
  const [filter, setFilter] = useState("");
  const menuId = useId();
  const [settings, setSettings] = useState(false);
  const [preferences, setPreferences] = useState(readBoard);
  function update(next: BoardPreferences) {
    setPreferences(next);
    try {
      localStorage.setItem(boardStorage, JSON.stringify(next));
    } catch {
      /* Keep preferences in memory when storage is unavailable. */
    }
  }
  function toggle(key: "lanes" | "metrics", id: string) {
    const hidden = preferences[key];
    update({
      ...preferences,
      [key]: hidden.includes(id) ? hidden.filter((v) => v !== id) : [...hidden, id],
    });
  }
  return (
    <div className="task-board">
      <header>
        <label className="search">
          <Icon name="search" />
          <input
            value={filter}
            aria-label="Search tasks"
            placeholder="Search tasks"
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <Tool
          label="Board settings"
          icon="filter"
          aria-expanded={settings}
          popoverTarget={menuId}
        />
        <div
          className="board-settings-menu"
          id={menuId}
          popover="auto"
          onToggle={(e) => setSettings(e.newState === "open")}
        >
          <div className="board-settings-label">Lanes</div>
          {boardLanes.map((lane) => (
            <button
              type="button"
              key={lane}
              aria-pressed={!preferences.lanes.includes(lane)}
              disabled={
                !preferences.lanes.includes(lane) &&
                preferences.lanes.length === boardLanes.length - 1
              }
              onClick={() => toggle("lanes", lane)}
            >
              {lane}
              {!preferences.lanes.includes(lane) && <Icon name="check" />}
            </button>
          ))}
          <div className="board-settings-label">Insights</div>
          {metricOptions.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              aria-pressed={!preferences.metrics.includes(id)}
              onClick={() => toggle("metrics", id)}
            >
              {label}
              {!preferences.metrics.includes(id) && <Icon name="check" />}
            </button>
          ))}
          <div className="board-settings-label">Insights period</div>
          {Object.entries(periods).map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={preferences.period === key}
              onClick={() => update({ ...preferences, period: key as Period })}
            >
              {label}
              {preferences.period === key && <Icon name="check" />}
            </button>
          ))}
        </div>
      </header>
      <div className="board-scroll">
        <TaskInsights period={preferences.period} hidden={preferences.metrics} />
        <div className="board-lanes">
          {boardLanes
            .filter((lane) => !preferences.lanes.includes(lane))
            .map((lane) => {
              const items = boardTasks.filter(
                (t) => t.lane === lane && t.title.toLowerCase().includes(filter.toLowerCase()),
              );
              return (
                <section key={lane}>
                  <header>
                    {lane}
                    <i className="spacer" />
                    {items.length}
                  </header>
                  {items.map((t) => (
                    <button className="board-card" key={t.id} onClick={() => onTask(t.id)}>
                      <small>
                        <i className={"mark mark-" + t.project.toLowerCase()}>
                          {t.project === "Conn" ? "CN" : t.project.slice(0, 2).toUpperCase()}
                        </i>{" "}
                        #{t.id}
                      </small>
                      {t.title}
                      <small>
                        {t.subtasks && t.subtasks + " subtasks · "}
                        {t.node}
                      </small>
                    </button>
                  ))}
                </section>
              );
            })}
        </div>
      </div>
    </div>
  );
}
