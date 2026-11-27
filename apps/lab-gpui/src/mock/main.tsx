import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import { observeResize } from "../../../web/src/lib/observeResize";
import { Settings } from "./Settings";
import { currentTheme } from "./themes";
import {
  ImageAttachments,
  ImageLayoutExamples,
  ImageMessage,
  sampleImages,
  type SampleImage,
} from "./ImageAttachments";
import { Composer } from "./Composer";
import { DesktopTooltip } from "./DesktopTooltip";
import { Icon, Tool } from "./Icon";
import { SidePanel } from "./Panel";
import { LabProjectContext } from "./LabProjectContext";
import { ThreadDetails } from "./ThreadDetails";
import {
  QUEUED_FIXTURE,
  QueueTray,
  type ForcedHover,
  type PendingSend,
  type QueuedMessage,
} from "./QueueTray";
import { walkthroughReveal, type FileLocation, type FileSelection } from "./FilesPanel";
import {
  comparisonThreads,
  delegationThread,
  defaultThread,
  filesThread,
  imageGallery,
  panels,
  queueThread,
  backgroundThread,
  tasks,
  type Panel,
} from "./fixtures";
import { BackgroundWorkFeed } from "./BackgroundWork";
import "./desktop.css";

const ThreadCardFeed = lazy(() => import("./ThreadCardFeed"));
const DesktopRequestDock = lazy(async () => ({
  default: (await import("./ThreadCardFeed")).DesktopRequestDock,
}));

interface PanelLocation {
  item?: string;
  section?: string;
  file?: string;
  start?: number;
  end?: number;
  details?: boolean;
}
const panelSlug = (panel: Panel) => panel.toLowerCase().replaceAll(" ", "-");

function readRoute() {
  const url = new URL(location.href);
  const params = url.searchParams;
  const id = params.get("thread") ?? url.hash.split("/").pop();
  const panel = panels.find((p) => panelSlug(p) === params.get("panel")?.toLowerCase()) ?? null;
  const file = params.get("file") ?? "";
  const start = Math.max(1, Number.parseInt(params.get("start") ?? "", 10) || 1);
  const end = Math.max(start, Number.parseInt(params.get("end") ?? "", 10) || start);
  return {
    thread: comparisonThreads.find((t) => t.id === id) ?? delegationThread,
    panel,
    item: params.get("item") ?? "",
    section: params.get("section") ?? "",
    file,
    details: params.get("details") === "1",
    reveal: panel === "Files" && file ? { path: file, start, end } : undefined,
  };
}
function panelUrl(id: string, panel: Panel | null, location: PanelLocation = {}) {
  const url = new URL(window.location.href);
  url.searchParams.delete("thread");
  url.hash = "/environment-render/" + id;
  url.searchParams.set("panel", panel ? panelSlug(panel) : "none");
  for (const key of ["item", "section", "file", "start", "end", "details"] as const) {
    const value = location[key];
    if (value) url.searchParams.set(key, value === true ? "1" : String(value));
    else url.searchParams.delete(key);
  }
  return url;
}
/** `?queue=N` queued rows (the queue thread defaults to 2), `?pending=sending|offline`. */
function readQueue(threadId: string): { rows: QueuedMessage[]; pending: PendingSend[] } {
  const params = new URLSearchParams(location.search);
  const count = Number.parseInt(params.get("queue") ?? "", 10);
  const rows = Array.from(
    { length: Number.isNaN(count) ? (threadId === queueThread.id ? 2 : 0) : Math.max(0, count) },
    (_, i) => ({ id: "queued-" + (i + 1), text: QUEUED_FIXTURE[i % QUEUED_FIXTURE.length]! }),
  );
  const state = params.get("pending");
  const pending: PendingSend[] =
    state === "sending" || state === "offline"
      ? [
          {
            id: "pending-1",
            text: "Also check the Database panel in light mode.",
            status: state === "offline" ? "Waiting for connection" : "Sending…",
          },
        ]
      : [];
  return { rows, pending };
}
/** `?queue-hover=2` hovers the second row; `2:steer|remove|more` hovers its button, `2:menu`
 * opens its ⋯ menu. */
function readForcedHover(): ForcedHover | undefined {
  const [row, part] = (new URLSearchParams(location.search).get("queue-hover") ?? "").split(":");
  const index = Number.parseInt(row ?? "", 10);
  if (!index) return undefined;
  return part === "menu"
    ? { row: index, button: "more", menu: true }
    : {
        row: index,
        button: part === "steer" || part === "remove" || part === "more" ? part : undefined,
      };
}
const locationLabel = (range: FileLocation) =>
  range.path + "#L" + range.start + (range.end !== range.start ? "–L" + range.end : "");

function ProjectMark({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className={"mark mark-" + name.replaceAll(" ", "-")}>
      {name === "conn"
        ? "CN"
        : name === "orbit"
          ? "OR"
          : name === "No project"
            ? "GL"
            : name === "Conn - Dev"
              ? "CD"
              : "AS"}
    </span>
  );
}
function DesktopLab() {
  const [sidebarWidth, setSidebarWidth] = useState(253.3671875);
  const [panelWidth, setPanelWidth] = useState(600);
  const [appearanceMenu, setAppearanceMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [route, setRoute] = useState(readRoute);
  const { thread, panel, details } = route;
  const [draftSelections, setDraftSelections] = useState<Record<string, FileSelection[]>>({});
  const selections = draftSelections[thread.id] ?? [];
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [filter, setFilter] = useState(false);
  const [sidebar, setSidebar] = useState(() => innerWidth >= 760);
  const [maxPanel, setMaxPanel] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [theme, setTheme] = useState(currentTheme);
  const [opaque, setOpaque] = useState(false);
  const [context, setContext] = useState(false);
  const nextMessage = useRef(0);
  const stage = new URLSearchParams(location.search).get("stage");
  const draftExample = stage === "composer";
  // `?stage=general`: a new General thread's draft (GPUI `render_draft_hero`).
  const generalDraft = stage === "general";
  const [draftImages, setDraftImages] = useState<SampleImage[]>(() =>
    draftExample ? sampleImages : [],
  );
  const gallery = thread.id === imageGallery.id;
  const [sent, setSent] = useState<
    Record<
      string,
      { id: string; text: string; images: SampleImage[]; selections: FileSelection[] }[]
    >
  >({});
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [editingQueued, setEditingQueued] = useState<{ id: string; text: string }>();
  const fixtureQueue = readQueue(thread.id);
  const queue = queues[thread.id] ?? fixtureQueue.rows;
  const running = queue.length > 0 || fixtureQueue.pending.length > 0;
  function setQueue(next: QueuedMessage[]) {
    setQueues((all) => ({ ...all, [thread.id]: next }));
  }
  function moveQueued(id: string, step: -1 | 1) {
    const from = queue.findIndex((row) => row.id === id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= queue.length) return;
    const next = [...queue];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setQueue(next);
  }
  function send(text: string, images: SampleImage[], sentSelections: FileSelection[]) {
    const id = String(++nextMessage.current);
    setSent((current) => ({
      ...current,
      [thread.id]: [
        ...(current[thread.id] ?? []),
        { id, text, images, selections: sentSelections },
      ],
    }));
  }
  const end = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const chatDock = useRef<HTMLDivElement>(null);
  const extra = sent[thread.id];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep the scroll clearance in sync with the overlaid dock
  useLayoutEffect(() => {
    const scroll = timeline.current;
    const dock = chatDock.current;
    if (!scroll || !dock) return;
    const measure = () => {
      const atEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 1;
      scroll.style.setProperty("--chat-dock-height", `${dock.offsetHeight}px`);
      if (atEnd) scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    return observeResize(dock, measure);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the fixture with browser history.
  useEffect(() => {
    const sync = () => {
      setRoute(readRoute());
      setTheme(currentTheme());
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the timeline DOM to the submitted message.
  useEffect(() => {
    if (extra?.length) end.current?.scrollIntoView({ block: "nearest" });
  }, [extra]);
  function navigate(id: string, nextPanel: Panel | null, next: PanelLocation = {}) {
    const url = panelUrl(id, nextPanel, next);
    if (url.href !== window.location.href) history.pushState(null, "", url);
    setRoute(readRoute());
  }
  function selectTask(id: number | null) {
    navigate(thread.id, "Tasks", { item: id === null ? "" : String(id) });
  }
  function selectPr(id: string | null) {
    navigate(thread.id, "Pull requests", { item: id ?? "" });
  }
  function setDetails(open: boolean) {
    navigate(thread.id, panel, {
      item: route.item,
      section: route.section,
      file: route.file,
      ...(route.reveal ? { start: route.reveal.start, end: route.reveal.end } : {}),
      details: open,
    });
  }
  function addSelection(selection: FileSelection) {
    setDraftSelections((all) => {
      const previous = all[thread.id] ?? [];
      return {
        ...all,
        [thread.id]: [
          ...previous.filter(
            (s) =>
              s.path !== selection.path || s.start !== selection.start || s.end !== selection.end,
          ),
          selection,
        ],
      };
    });
  }
  function sourceLink(range: FileLocation) {
    const next = { file: range.path, start: range.start, end: range.end };
    return (
      <a
        className="source-reference"
        aria-label={"Open " + locationLabel(range)}
        href={panelUrl(thread.id, "Files", next).href}
        onClick={(event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          navigate(thread.id, "Files", next);
        }}
      >
        <Icon name="file-code" />
        {locationLabel(range).split("/").at(-1)}
      </a>
    );
  }
  function chooseTheme(id: string) {
    const url = new URL(location.href);
    url.searchParams.set("theme", id);
    history.replaceState(null, "", url);
    setTheme(currentTheme());
  }
  const palette = theme.colors;
  const style = Object.fromEntries(
    Object.entries(palette).map(([key, value]) => ["--native-" + key, value]),
  ) as CSSProperties;
  Object.assign(style, {
    "--gallery-columns": new URLSearchParams(location.search).get("columns") === "3" ? 3 : 4,
    "--sidebar-width": sidebarWidth + "px",
    "--panel-width": panelWidth + "px",
  });
  const matched = comparisonThreads.filter(
    (t) =>
      (!project || t.project === project) &&
      (t.title + " " + t.project + " " + t.branch).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className="desktop"
      style={style}
      data-theme={theme.appearance}
      data-opaque={opaque}
      data-sidebar={sidebar}
      data-panel={!!panel}
      data-max-panel={!!panel && maxPanel}
    >
      <DesktopTooltip />
      <div className="traffic" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      {sidebar && (
        <nav className="rail" aria-label="Workspaces">
          <Tool
            icon="layers"
            label="All projects"
            aria-pressed={!project}
            onClick={() => setProject("")}
          />
          {["orbit", "conn"].map((p) => (
            <button
              key={p}
              className="tool"
              data-tip={p}
              aria-label={p + " workspace"}
              aria-pressed={project === p}
              onClick={() => setProject(project === p ? "" : p)}
            >
              <Icon name={p === "orbit" ? "orbit" : "conn-mark"} />
            </button>
          ))}
          <span className="rail-static">
            <Icon name="add" />
          </span>
          <div className="spacer" />
          <Tool
            icon="chart"
            label="Tasks & usage"
            aria-pressed={panel === "Tasks"}
            onClick={() => navigate(thread.id, panel === "Tasks" ? null : "Tasks")}
          />
          <Tool
            icon="pull-request"
            label="Pull requests"
            aria-pressed={panel === "Pull requests"}
            onClick={() => navigate(thread.id, panel === "Pull requests" ? null : "Pull requests")}
          />
          <div className="rail-settings">
            <Tool
              icon="settings"
              label="Settings"
              aria-expanded={appearanceMenu}
              onClick={() => setAppearanceMenu(!appearanceMenu)}
            />
          </div>
        </nav>
      )}
      {sidebar && (
        <aside className="sidebar" aria-label="Threads">
          <header>
            <Tool label="Hide sidebar" icon="sidebar-left" onClick={() => setSidebar(false)} />
          </header>
          <div className="search-row">
            <label className="search">
              <Icon name="search" />
              <input
                aria-label="Search threads"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <Tool
              icon="filter"
              label="Filter by project"
              aria-expanded={filter}
              onClick={() => setFilter(!filter)}
            />
            <span className="toolbar-glyph">
              <Icon name="folder-add" />
            </span>
            <span className="toolbar-glyph">
              <Icon name="compose" />
            </span>
            {filter && (
              <div className="menu">
                {["", "conn", "apps", "orbit"].map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      setProject(p);
                      setFilter(false);
                    }}
                  >
                    {p || "All projects"}
                    {p === project && <Icon name="check" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="thread-list">
            {matched.map((t) => (
              <button
                className="thread-row"
                key={t.id}
                aria-current={t.id === thread.id ? "page" : undefined}
                onClick={() => {
                  navigate(t.id, panel);
                  if (innerWidth < 760) setSidebar(false);
                }}
              >
                <span className="mark-wrap">
                  {t.mark ? <Icon name={t.mark} /> : <ProjectMark name={t.project} />}
                  {t.waiting && <i className="waiting" />}
                </span>
                <span className="row-copy">
                  <strong>{t.title}</strong>
                  <small>
                    <Icon
                      name={
                        t.provider ??
                        (t.waiting || t.id === "delegation-smoke" ? "claude" : "openai")
                      }
                    />
                    <b>·</b>
                    {t.id === "delegation-smoke" ? "General" : (t.group ?? t.project)}
                    {t.branch && (
                      <>
                        <b>·</b>
                        <span className="branch-name">{t.branch}</span>
                      </>
                    )}
                    <b>·</b>
                    {t.age}
                  </small>
                </span>
              </button>
            ))}
            {!matched.length && <p className="empty">No matching threads</p>}
          </div>
          <Seam
            label="Resize sidebar"
            width={sidebarWidth}
            onWidth={(w) => setSidebarWidth(Math.max(153, Math.min(w, innerWidth - 694)))}
          />
        </aside>
      )}
      <main className="conversation">
        <header>
          {!sidebar && (
            <Tool icon="sidebar-left" label="Show sidebar" onClick={() => setSidebar(true)} />
          )}
          <Icon name="folder" />
          <span className="project-name">{thread.project}</span>
          <span className="slash">/</span>
          <strong className="title">{thread.title}</strong>
          <div className="spacer" />
          <Tool
            label="Toggle thread details"
            icon="panel-menu"
            aria-pressed={details}
            onClick={() => setDetails(!details)}
          />
          <Tool
            label="Toggle terminal"
            icon="panel-bottom"
            aria-pressed={terminal}
            onClick={() => setTerminal(!terminal)}
          />
          <Tool
            label="Toggle right panel"
            icon="sidebar-right"
            aria-pressed={!!panel}
            onClick={() => navigate(thread.id, panel ? null : "Tasks")}
          />
        </header>
        {details && (
          <ThreadDetails
            key={thread.id}
            thread={thread}
            onClose={() => setDetails(false)}
            onOpenPr={selectPr}
            onOpenTask={selectTask}
            onOpenFiles={() => navigate(thread.id, "Files")}
          />
        )}
        <article className="chat-card">
          <div className="chat-thread" data-hero={generalDraft || undefined}>
            <div className="timeline" ref={timeline}>
              {generalDraft && <h1 className="draft-heading">What should we work on?</h1>}
              <div className="messages" hidden={generalDraft}>
                {thread.id === "delegation-smoke" ? (
                  <>
                    <button
                      className="agent-line"
                      aria-expanded={expanded}
                      onClick={() => setExpanded(!expanded)}
                    >
                      <Icon name="agent" />
                      <strong>Agent</strong>
                      <span>{thread.prompt}</span>
                      <Icon name="chevron-right" />
                    </button>
                    {expanded && <p>{thread.prompt}</p>}
                    <div className="worked">
                      Worked for 9.3s <Icon name="chevron-right" />
                    </div>
                  </>
                ) : thread.id === "stalled-threads" ? (
                  <Suspense fallback={null}>
                    <ThreadCardFeed theme={theme} onOpenTask={selectTask} />
                  </Suspense>
                ) : thread.id === queueThread.id ? (
                  <>
                    <p className="bubble">{thread.prompt}</p>
                    <div className="worked">
                      Working for 12s <Icon name="chevron-right" />
                    </div>
                  </>
                ) : thread.id === "image-layouts" ? (
                  <ImageLayoutExamples />
                ) : gallery ? (
                  !draftExample && <ImageMessage images={sampleImages} text={thread.prompt} />
                ) : (
                  <p className="bubble">{thread.prompt}</p>
                )}
                {thread.reply && <p className="assistant-reply">{thread.reply}</p>}
                {thread.id === backgroundThread.id && <BackgroundWorkFeed />}
                {thread.id === filesThread.id && sourceLink(walkthroughReveal)}
                {thread.id === "image-attachments" && (
                  <p>
                    <a href="/image-preview/index.html">Open image preview</a>
                  </p>
                )}
                {thread.id === defaultThread.id && (
                  <>
                    <div className="task-receipts">
                      {tasks.map((t) => (
                        <button key={t.id} onClick={() => selectTask(t.id)}>
                          <span>
                            <Icon name="checklist" />
                            <strong>{t.title}</strong>
                            <i className={t.status === "Working" ? "working" : "review"} />
                          </span>
                          <small>
                            conn · #{t.id} · beast <em>#{t.pr}</em>
                          </small>
                        </button>
                      ))}
                    </div>
                    <p>Both tasks are in Orbit. Open one to follow its subtasks.</p>
                  </>
                )}

                {extra?.map((msg) => (
                  <div key={msg.id} className="user-message">
                    {msg.selections.map((selection) => (
                      <div key={locationLabel(selection)} className="sent-code-reference">
                        {sourceLink(selection)}
                        <details>
                          <summary>Selected code</summary>
                          <pre>{selection.text}</pre>
                        </details>
                      </div>
                    ))}
                    {msg.images?.length ? (
                      <ImageMessage images={msg.images} text={msg.text} />
                    ) : (
                      msg.text && <p className="bubble">{msg.text}</p>
                    )}
                  </div>
                ))}
                <div className="timeline-end" ref={end} />
              </div>
            </div>
            <div className="chat-dock" ref={chatDock}>
              <Composer
                key={thread.id + ":" + (editingQueued?.id ?? "")}
                agentSmoke={thread.id === "delegation-smoke"}
                running={running}
                editing={editingQueued}
                abovePrompt={
                  thread.id === "stalled-threads" ? (
                    <Suspense fallback={null}>
                      <DesktopRequestDock theme={theme} />
                    </Suspense>
                  ) : (
                    <QueueTray
                      rows={queue}
                      pending={fixtureQueue.pending}
                      forced={readForcedHover()}
                      editing={editingQueued?.id}
                      onSteer={(id) => {
                        const row = queue.find((r) => r.id === id);
                        setQueue(queue.filter((r) => r.id !== id));
                        if (row) send(row.text, [], []);
                      }}
                      onRemove={(id) => setQueue(queue.filter((r) => r.id !== id))}
                      onMove={moveQueued}
                      onEdit={(id) => {
                        const row = queue.find((r) => r.id === id);
                        setEditingQueued(row ? { id: row.id, text: row.text } : undefined);
                      }}
                    />
                  )
                }
                attachments={
                  selections.length || (gallery && draftImages.length) ? (
                    <>
                      {selections.map((selection) => (
                        <div className="composer-code-reference" key={locationLabel(selection)}>
                          <details>
                            <summary>
                              <Icon name="file-code" /> {locationLabel(selection)}
                            </summary>
                            <pre>{selection.text}</pre>
                          </details>
                          <Tool
                            icon="close"
                            label={"Remove " + locationLabel(selection)}
                            onClick={() =>
                              setDraftSelections((all) => ({
                                ...all,
                                [thread.id]: (all[thread.id] ?? []).filter((s) => s !== selection),
                              }))
                            }
                          />
                        </div>
                      ))}
                      {gallery && draftImages.length > 0 && (
                        <ImageAttachments
                          images={draftImages}
                          onRemove={(image) =>
                            setDraftImages((current) => current.filter((entry) => entry !== image))
                          }
                        />
                      )}
                    </>
                  ) : null
                }
                onSend={(message, followUp) => {
                  if (editingQueued) {
                    setQueue(
                      queue.map((row) =>
                        row.id === editingQueued.id ? { ...row, text: message } : row,
                      ),
                    );
                    setEditingQueued(undefined);
                    return;
                  }
                  // While a turn runs, a follow-up waits in the tray unless Steer is chosen.
                  if (running && followUp === "Queue") {
                    setQueue([...queue, { id: "queued-" + ++nextMessage.current, text: message }]);
                    return;
                  }
                  const images = gallery ? draftImages : [];
                  if (images.length) setDraftImages([]);
                  if (selections.length) setDraftSelections((all) => ({ ...all, [thread.id]: [] }));
                  send(message, images, selections);
                }}
              />
              {context && (
                <div className="composer-context">
                  <Icon name="folder" />
                  Local
                  <Icon name="branch" />
                  {thread.branch || "main"}
                </div>
              )}
            </div>
          </div>
          {terminal && <TerminalDrawer project={thread.project} />}
        </article>
      </main>
      {appearanceMenu && (
        <Settings
          id={theme.id}
          onTheme={chooseTheme}
          onClose={() => setAppearanceMenu(false)}
          opaque={opaque}
          onOpaque={() => setOpaque(!opaque)}
          context={context}
          onContext={() => setContext(!context)}
        />
      )}
      {panel && (
        <LabProjectContext.Provider value={thread.project}>
          <SidePanel
            panel={panel}
            maximized={maxPanel}
            onMaximize={() => setMaxPanel(!maxPanel)}
            key={thread.id}
            item={route.item}
            section={route.section}
            file={route.file}
            reveal={route.reveal}
            onFile={(range) =>
              navigate(
                thread.id,
                "Files",
                range ? { file: range.path, start: range.start, end: range.end } : {},
              )
            }
            onAddSelection={addSelection}
            onTask={selectTask}
            onPr={selectPr}
            onSection={(section, file = "") =>
              navigate(thread.id, panel, { item: route.item, section, file })
            }
            seam={
              <Seam
                label="Resize right panel"
                width={panelWidth}
                reverse
                onWidth={(w) => setPanelWidth(Math.max(360, Math.min(w, innerWidth * 0.7)))}
              />
            }
            onPanel={(p) => navigate(thread.id, p)}
            onClose={() => {
              setMaxPanel(false);
              navigate(thread.id, null);
            }}
          />
        </LabProjectContext.Provider>
      )}
    </div>
  );
}
function TerminalDrawer({ project }: { project: string }) {
  const [height, setHeight] = useState(280);
  const [clear, setClear] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  return (
    <section className="terminal" aria-label="Terminal" style={{ height }}>
      <div
        className="terminal-resize"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        onDoubleClick={() => setHeight(280)}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setHeight(
              Math.min(
                innerHeight * 0.75,
                Math.max(180, drag.current.height + drag.current.y - e.clientY),
              ),
            );
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      <div className="terminal-actions">
        <Tool label="Clear terminal" icon="clean" onClick={() => setClear(true)} />
        <Tool label="Restart terminal" icon="refresh" onClick={() => setClear(false)} />
      </div>
      <pre>
        {!clear && (
          <>
            nick@mac <span>~/apps/{project === "No project" ? "" : project}</span> %{" "}
          </>
        )}
        <i />
      </pre>
    </section>
  );
}
// Native seams track the pointer until release, including outside their original bounds.
function Seam({
  label,
  width,
  onWidth,
  reverse = false,
}: {
  label: string;
  width: number;
  onWidth: (n: number) => void;
  reverse?: boolean;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className={"seam" + (reverse ? " left" : "")}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          onWidth(drag.current.width + (e.clientX - drag.current.x) * (reverse ? -1 : 1));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onWidth(width + (e.key === "ArrowRight" ? 8 : -8) * (reverse ? -1 : 1));
        }
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<DesktopLab />);
