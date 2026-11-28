import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  browseTableSql,
  connectionTarget,
  DRIVER_LABELS,
  type DatabaseConnection,
  type DatabaseDriver,
} from "../../../web/src/database/databaseApi";
import vaultIcon from "../../../web/src/database/vault-icon.png";
import HighlightedCode from "../../../lab-ios/src/components/HighlightedCode";
import { labDatabaseRun } from "../database";
import {
  describeTable,
  envDatabase,
  tableNames,
  vaultDatabase,
  type LabQueryReply,
} from "./databaseFixture";
import { LabProjectContext } from "./LabProjectContext";
import { Icon, Tool } from "./Icon";
import "./DatabasePanel.css";

type ProjectDatabaseState = {
  saved: DatabaseConnection[];
  selected: string;
  drafts: Record<string, string>;
};
const initialState: ProjectDatabaseState = { saved: [], selected: envDatabase.id, drafts: {} };
function loadProject(key: string): ProjectDatabaseState {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as ProjectDatabaseState | null;
    if (saved && Array.isArray(saved.saved) && typeof saved.selected === "string" && saved.drafts)
      return saved;
  } catch {
    /* A private browser session can still use temporary connections. */
  }
  return initialState;
}
const defaultQuery = browseTableSql(envDatabase.driver, "tasks");

function ConnectionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: DatabaseConnection;
  onSave: (next: DatabaseConnection) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  function field(
    key: "name" | "host" | "database" | "username" | "password",
    label: string,
    placeholder = "",
  ) {
    return (
      <label>
        {label}
        <input
          value={draft[key]}
          type={key === "password" ? "password" : "text"}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        />
      </label>
    );
  }
  return (
    <form
      className="lab-db-form"
      aria-label="Database connection settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...draft, name: draft.name.trim() || connectionTarget(draft), password: "" });
      }}
    >
      {field("name", "Name", connectionTarget(draft) || "My database")}
      <fieldset>
        <legend>Driver</legend>
        <div className="lab-db-segments">
          {(Object.keys(DRIVER_LABELS) as DatabaseDriver[]).map((driver) => (
            <button
              type="button"
              key={driver}
              aria-pressed={draft.driver === driver}
              onClick={() => setDraft({ ...draft, driver, port: null })}
            >
              {DRIVER_LABELS[driver]}
            </button>
          ))}
        </div>
      </fieldset>
      {draft.driver === "sqlite" ? (
        field("database", "File on this Mac", "/Users/me/app/database/database.sqlite")
      ) : (
        <>
          <div className="lab-db-address">
            {field("host", "Host", "127.0.0.1")}
            <label>
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.port ?? ""}
                placeholder={draft.driver === "pgsql" ? "5432" : "3306"}
                onChange={(e) =>
                  setDraft({ ...draft, port: e.target.value ? Number(e.target.value) : null })
                }
              />
            </label>
          </div>
          {field("database", "Database")}
          {field("username", "Username")}
          {field("password", "Password")}
        </>
      )}
      <div className="lab-db-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!draft.database.trim()}>
          Save connection
        </button>
      </div>
    </form>
  );
}

function ProjectDatabase({ project }: { project: string }) {
  const storageKey = "conn.lab.database.v1:" + project;
  const [state, setState] = useState(() => loadProject(storageKey));
  const [editing, setEditing] = useState<DatabaseConnection | null>(null);
  const [tables, setTables] = useState(() => tableNames(envDatabase));
  const menu = useRef<HTMLDivElement>(null);
  // The menu filters by name and target, and the arrows move a highlight.
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const connection =
    [envDatabase, ...state.saved, vaultDatabase].find((c) => c.id === state.selected) ??
    envDatabase;
  function update(next: ProjectDatabaseState) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Keep the current draft in memory. */
    }
    setState(next);
  }
  function select(id: string) {
    menu.current?.hidePopover();
    setEditing(null);
    update({ ...state, selected: id });
  }
  function edit(copy: boolean) {
    menu.current?.hidePopover();
    setEditing(
      copy
        ? {
            ...envDatabase,
            id:
              "manual-" +
              (state.saved.length
                ? Math.max(...state.saved.map((c) => Number(c.id.slice(7)) || 0)) + 1
                : 1),
            name: "",
            source: "manual",
          }
        : connection,
    );
  }
  const q = query.trim().toLowerCase();
  const matches = (item: DatabaseConnection) =>
    !q || (item.name + " " + connectionTarget(item)).toLowerCase().includes(q);
  const shownConnections = [envDatabase, ...state.saved].filter(matches);
  const shownVault = [vaultDatabase].filter(matches);
  const shown = [...shownConnections, ...shownVault];
  function connectionOption(item: DatabaseConnection) {
    return (
      <button
        key={item.id}
        type="button"
        aria-pressed={connection.id === item.id}
        data-highlighted={shown[highlight]?.id === item.id || undefined}
        data-tip={item.name + " · " + connectionTarget(item)}
        onClick={() => select(item.id)}
      >
        {item.source === "vault" && <img src={vaultIcon} alt="" />}
        <span>{item.name}</span>
        {item.source !== "vault" && <small>{connectionTarget(item)}</small>}
        {connection.id === item.id && <Icon name="check" />}
      </button>
    );
  }
  const connectionTools = (
    <>
      <button
        type="button"
        className="lab-db-picker"
        popoverTarget="lab-db-connections"
        aria-label="Database connection"
      >
        {connection.source === "vault" ? (
          <img src={vaultIcon} alt="Vault" />
        ) : (
          <Icon name="database" />
        )}
        <strong>{connection.name}</strong>
        {connection.source !== "vault" && <span>{connectionTarget(connection)}</span>}
        <Icon name="chevron-down" />
      </button>
      <div
        popover="auto"
        ref={menu}
        id="lab-db-connections"
        className="lab-db-menu"
        onToggle={(event) => {
          if (!event.currentTarget.matches(":popover-open")) return;
          setQuery("");
          setHighlight(0);
          event.currentTarget.querySelector("input")?.focus();
        }}
      >
        <label className="lab-db-menu-search">
          <Icon name="search" />
          <input
            aria-label="Search connections"
            placeholder="Search connections…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
                event.preventDefault();
                setHighlight(
                  (highlight + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length,
                );
              } else if (event.key === "Enter" && shown[highlight]) {
                select(shown[highlight].id);
              }
            }}
          />
        </label>
        <div className="lab-db-menu-list">
          {shownConnections.length > 0 && <div className="lab-db-menu-label">Connections</div>}
          {shownConnections.map(connectionOption)}
          {shownVault.length > 0 && <div className="lab-db-menu-label">Vault</div>}
          {shownVault.map(connectionOption)}
          {!shown.length && <p className="lab-db-menu-empty">No matches</p>}
        </div>
        <div className="lab-db-menu-actions">
          <button onClick={() => edit(true)}>Add connection…</button>
          {connection.source !== "vault" && (
            <button onClick={() => edit(connection.source === "env")}>
              {connection.source === "env" ? "Copy to a new connection…" : "Edit connection…"}
            </button>
          )}
          {connection.source === "manual" && (
            <button
              onClick={() => {
                menu.current?.hidePopover();
                setEditing(null);
                const drafts = { ...state.drafts };
                delete drafts[connection.id];
                update({
                  saved: state.saved.filter((c) => c.id !== connection.id),
                  drafts,
                  selected: envDatabase.id,
                });
              }}
            >
              Delete connection
            </button>
          )}
        </div>
      </div>
      <Tool icon="refresh" label="Refresh" onClick={() => setTables(tableNames(connection))} />
    </>
  );
  return (
    <section className="lab-db" aria-label="Database panel">
      {editing ? (
        <>
          <header className="lab-db-toolbar">{connectionTools}</header>
          <ConnectionEditor
            key={editing.id}
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={(saved) => {
              update({
                ...state,
                saved: [...state.saved.filter((c) => c.id !== saved.id), saved],
                selected: saved.id,
              });
              setEditing(null);
            }}
          />
        </>
      ) : (
        <DatabaseWorkspace
          key={connection.id}
          connectionTools={connectionTools}
          tableList={tables}
          connection={connection}
          sql={state.drafts[connection.id] ?? (connection.source === "env" ? defaultQuery : "")}
          setSql={(sql) => update({ ...state, drafts: { ...state.drafts, [connection.id]: sql } })}
        />
      )}
    </section>
  );
}
function DatabaseWorkspace({
  connectionTools,
  tableList,
  connection,
  sql,
  setSql,
}: {
  connection: DatabaseConnection;
  connectionTools: ReactNode;
  tableList: readonly string[];
  sql: string;
  setSql: (sql: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(sql === defaultQuery ? "tasks" : null);
  const [tab, setTab] = useState<"Rows" | "Structure">("Rows");
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState<LabQueryReply | null>(() => {
    if (sql !== defaultQuery) return null;
    const data = labDatabaseRun({ connection, operation: "query", sql });
    return {
      result: {
        columns: [...data.resultColumns],
        rows: data.rows.map((row) =>
          data.resultColumns.map((col) => {
            const value = row[col];
            return typeof value === "boolean" ? Number(value) : (value ?? null);
          }),
        ),
        truncated: data.truncated,
        durationMs: data.durationMs,
      },
    };
  });
  const worker = useRef<Worker | null>(null);
  const overlay = useRef<HTMLPreElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Dispose the query worker when its connection leaves the panel.
  useEffect(() => () => worker.current?.terminate(), []);
  function run(statement: string) {
    if (!statement.trim()) return;
    worker.current?.terminate();
    setRunning(true);
    setTab("Rows");
    setReply(null);
    const queryWorker = new Worker(new URL("./databaseQuery.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = queryWorker;
    function finish(value: LabQueryReply) {
      queryWorker.terminate();
      if (worker.current === queryWorker) {
        worker.current = null;
        setReply(value);
        setRunning(false);
      }
    }
    queryWorker.onmessage = (event: MessageEvent<LabQueryReply>) => finish(event.data);
    queryWorker.onerror = (e) =>
      finish({ error: e.message || "Unable to open the preview database." });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Posts to this dedicated SQL worker.
    queryWorker.postMessage(statement);
  }
  const tables = tableList.filter((t) => t.includes(filter.trim().toLowerCase()));
  const columns = selected ? describeTable(connection, selected) : [];
  const result = reply && "result" in reply ? reply.result : null;
  return (
    <>
      <header className="lab-db-toolbar">
        {connectionTools}
        <button className="lab-db-run" disabled={running || !sql.trim()} onClick={() => run(sql)}>
          <Icon name="play" />
          Run
        </button>
      </header>
      <div
        className="lab-db-workspace"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            run(sql);
          }
        }}
      >
        <aside className="lab-db-tables" aria-label="Database tables">
          <label className="lab-db-search">
            <Icon name="search" />
            <input
              aria-label="Filter tables"
              placeholder="Tables"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <div className="lab-db-table-list">
            {tables.map((name) => (
              <button
                key={name}
                aria-pressed={name === selected}
                onClick={() => {
                  const next = browseTableSql(connection.driver, name);
                  setSelected(name);
                  setSql(next);
                  run(next);
                }}
              >
                {name}
              </button>
            ))}
            {!tables.length && <p>No tables</p>}
          </div>
        </aside>
        <div className="lab-db-main">
          <div className="lab-db-editor">
            <pre ref={overlay} aria-hidden="true">
              <HighlightedCode language="sql" code={sql} />
              {"\u200b"}
            </pre>
            <textarea
              aria-label="SQL query"
              spellCheck={false}
              placeholder="select * from users limit 100"
              value={sql}
              onScroll={(e) => {
                if (overlay.current) overlay.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onChange={(e) => setSql(e.target.value)}
            />
            {result && (
              <small className="lab-db-duration">
                {result.truncated ? "First 500 rows · " : ""}
                {result.durationMs} ms
              </small>
            )}
          </div>
          <div className="lab-db-resultbar">
            <nav aria-label="Database result sections">
              {(["Rows", "Structure"] as const).map((name) => (
                <button key={name} aria-pressed={name === tab} onClick={() => setTab(name)}>
                  {name}{" "}
                  <small>
                    {name === "Rows" ? result?.rows.length : selected ? columns.length : ""}
                  </small>
                </button>
              ))}
            </nav>
          </div>
          <div className="lab-db-results" aria-live="polite" aria-busy={running}>
            {tab === "Structure" ? (
              selected ? (
                <dl>
                  {columns.map((c) => (
                    <div key={c.name}>
                      <dt>
                        {c.name}{" "}
                        {c.primary && (
                          <span aria-label="Primary key" role="img">
                            <Icon name="lock" />
                          </span>
                        )}
                      </dt>
                      <dd>
                        {c.type}
                        {c.nullable ? " · nullable" : ""}
                        {c.default !== null ? " · default " + c.default : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>Pick a table to see its columns.</p>
              )
            ) : reply && "error" in reply ? (
              <p role="alert" className="lab-db-notice">
                {reply.error}
              </p>
            ) : result ? (
              <table>
                <thead>
                  <tr>
                    {result.columns.map((c, i) => (
                      // oxlint-disable-next-line react/no-array-index-key -- Query results replace the whole grid and allow duplicate columns and rows.
                      <th key={i}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    // oxlint-disable-next-line react/no-array-index-key -- Query results replace the whole grid and allow duplicate columns and rows.
                    <tr key={i}>
                      {row.map((v, j) => (
                        // oxlint-disable-next-line react/no-array-index-key -- Query results replace the whole grid and allow duplicate columns and rows.
                        <td key={j}>{v === null ? <i>NULL</i> : String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>{running ? "Running…" : "Pick a table, or write a query and press ⌘↵."}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
export function DatabasePanel() {
  const project = useContext(LabProjectContext);
  return <ProjectDatabase key={project} project={project} />;
}
